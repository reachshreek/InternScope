import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { discoverBoards } from '../server/discovery.js';
import { openStore } from '../server/db.js';
import { createRefresher } from '../server/refresh.js';
import { createApp } from '../server/index.js';
import { fetchJson } from '../server/providers.js';
import { parseSearchHtml, collectWebSource, fetchSearchHtml, SourceAccessError, parseIndexedJobs, searchQueries, approximateDate } from '../server/web-sources.js';

const linkedInPage = `<ul><li><div class="base-search-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/software-intern-1234567890?trackingId=abc"></a><h3 class="base-search-card__title">Software Intern — Summer 2027</h3><h4 class="base-search-card__subtitle">Example Labs</h4><span class="job-search-card__location">San Francisco, CA</span><time datetime="2026-10-20">1 day ago</time></div></li></ul>`;
const job = (id, extra = {}) => ({ title: 'Python Intern', company: 'Example Labs', location: 'Remote', url: `https://www.linkedin.com/jobs/view/${id}`, description: 'Python and SQL', terms: [], years: [], ...extra });
function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-discovery-'));
  const store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });
  return store;
}
test('board discovery uses verified ATS hosts, deduplicates and prioritizes recent active boards', () => {
  const boards = discoverBoards([
    { url: 'https://job-boards.greenhouse.io/old/jobs/1', company_name: 'Old', active: false, date_posted: 1 },
    { url: 'https://jobs.ashbyhq.com/example/123', company_name: 'New', active: true, date_posted: 10 },
    { url: 'https://jobs.ashbyhq.com/EXAMPLE/456', company_name: 'New', active: true, date_posted: 9 },
    { url: 'https://jobs.ashbyhq.com.evil.example/attacker/123' },
    { url: 'https://job-boards.greenhouse.io/%2e%2e/jobs/1' },
    { url: 'https://company.example/careers' }
  ]);
  assert.equal(boards.length, 2); assert.equal(boards[0].kind, 'ashby'); assert.equal(boards[0].token, 'example');
  assert.equal(discoverBoards([{ url: 'https://boards.greenhouse.io/embed/job_app?for=example&token=123', company_name: 'Example' }])[0].token, 'example');
});
test('all three public-search adapters normalize internship cards and dates', () => {
  const linkedin = parseSearchHtml('linkedin', linkedInPage);
  assert.equal(linkedin.length, 1); assert.equal(linkedin[0].url, 'https://www.linkedin.com/jobs/view/1234567890');
  assert.equal(linkedin[0].dateBasis, 'published'); assert.equal(linkedin[0].postedAt, '2026-10-20T00:00:00.000Z');
  const indeed = parseSearchHtml('indeed', `<div class="job_seen_beacon"><h2 class="jobTitle"><a data-jk="abcdef123" href="/rc/clk?jk=abcdef123">Data Intern</a></h2><span data-testid="company-name">Example Inc</span><div data-testid="text-location">Boston, MA</div><div class="job-snippet">Use Python and SQL</div><span class="date">Posted 2 days ago</span></div>`);
  assert.equal(indeed[0].url, 'https://www.indeed.com/viewjob?jk=abcdef123'); assert.equal(indeed[0].dateBasis, 'estimated');
  const zip = parseSearchHtml('ziprecruiter', `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Finance Intern', hiringOrganization: { name: 'Example Finance' }, url: 'https://www.ziprecruiter.com/c/Example/Job/Finance-Intern?jid=abc', description: '<p>Excel and finance.</p>', datePosted: '2026-10-20', jobLocation: { address: { addressLocality: 'Los Angeles', addressRegion: 'CA' } } })}</script>`);
  assert.equal(zip.length, 1); assert.equal(zip[0].company, 'Example Finance'); assert.match(zip[0].description, /Excel and finance/);
  assert.throws(() => parseSearchHtml('indeed', '<h1>Unrecognized page</h1>'), /format was not recognized/);
  assert.deepEqual(parseSearchHtml('indeed', '<p>No jobs found</p>'), []);
});
test('missing and off-domain result links never become fake postings', () => {
  const noLink = linkedInPage.replace('href="https://www.linkedin.com/jobs/view/software-intern-1234567890?trackingId=abc"', '');
  assert.equal(parseSearchHtml('linkedin', noLink).length, 0);
  assert.equal(parseSearchHtml('linkedin', linkedInPage.replace('www.linkedin.com/jobs/view', 'evil.example/jobs/view')).length, 0);
});
test('security checks and rate limits stop without retries or evasion', async () => {
  let requests = 0;
  await assert.rejects(() => fetchSearchHtml('https://www.indeed.com/jobs', async () => { requests++; return new Response('blocked', { status: 403 }); }), /restricted/);
  assert.equal(requests, 1);
  await assert.rejects(() => fetchSearchHtml('https://www.linkedin.com/jobs', async () => new Response('', { status: 429 })), /Rate limited/);
  await assert.rejects(() => fetchSearchHtml('https://www.ziprecruiter.com/jobs', async () => new Response('<title>Just a moment...</title>')), /security check/);
});
test('a later blocked page preserves partial search results', async () => {
  let calls = 0;
  const result = await collectWebSource({ kind: 'linkedin' }, { pages: 3, pause: async () => {}, htmlFetcher: async () => {
    if (calls++) throw new SourceAccessError('Rate limited', 'rate_limited');
    return linkedInPage;
  } });
  assert.equal(calls, 2); assert.equal(result.jobs.length, 1); assert.equal(result.complete, false); assert.match(result.warnings[0], /Rate limited/);
});
test('pagination advances by the real card count and LinkedIn descriptions enrich matches', async () => {
  const requests = [];
  const result = await collectWebSource({ kind: 'linkedin' }, { pages: 2, details: 1, pause: async () => {}, htmlFetcher: async url => {
    requests.push(new URL(url));
    if (url.includes('/jobPosting/')) return '<div class="show-more-less-html__markup"><p>Use Python and SQL to build reliable systems for Summer 2027.</p></div>';
    if (requests.length === 1) return linkedInPage;
    return '<p>No jobs found</p>';
  } });
  assert.equal(requests[1].searchParams.get('start'), '1');
  assert.match(result.jobs[0].description, /Python and SQL/); assert.equal(result.mode, 'public');
});
test('search queries use preferences only and never include resume text', () => {
  const queries = searchQueries({ resume: 'PRIVATE NAME SECRET EMAIL', roles: 'software, finance', locations: 'Boston, London' });
  assert.equal(queries.length, 6); assert.doesNotMatch(JSON.stringify(queries), /PRIVATE|SECRET|EMAIL/);
  assert.equal(approximateDate('2 days ago', Date.parse('2026-10-21')), '2026-10-19T00:00:00.000Z');
});
test('indexed fallback imports only links belonging to the requested platform', async () => {
  const fixture = { jobs_results: [{ title: 'Data Science Intern', company_name: 'Example Data', location: 'Remote', description: 'Python and SQL', detected_extensions: { posted_at: '1 day ago' }, apply_options: [{ title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=abcdef' }, { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/1234567890' }] }] };
  assert.equal(parseIndexedJobs(fixture, 'indeed')[0].url, 'https://www.indeed.com/viewjob?jk=abcdef');
  assert.equal(parseIndexedJobs(fixture, 'ziprecruiter').length, 0);
  let requested;
  const result = await collectWebSource({ kind: 'indeed' }, { jobspy: false, apiKey: 'test-key-only', htmlFetcher: async () => { throw new SourceAccessError('restricted'); }, jsonFetcher: async url => { requested = new URL(url); return fixture; } });
  assert.equal(result.mode, 'indexed'); assert.equal(result.jobs.length, 1);
  assert.equal(requested.hostname, 'serpapi.com'); assert.equal(requested.searchParams.get('engine'), 'google_jobs');
  assert.equal(requested.searchParams.get('no_cache'), 'true');
  assert.equal(result.jobs[0].dateBasis, 'estimated');
});
test('partial search snapshots preserve applications and unseen prior results', t => {
  const store = temporaryStore(t), source = store.sources().find(s => s.kind === 'linkedin');
  store.ingest(source, [job('1234567890'), job('1234567891')], { complete: false });
  const first = store.jobs().find(j => j.url.endsWith('1234567890'));
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(first.id, 'applied', '2026-10-21', 'Already applied');
  store.ingest(source, [job('1234567892')], { complete: false });
  assert.equal(store.jobs().length, 3); assert.equal(store.jobs().filter(j => j.active).length, 3);
  assert.equal(store.jobs().find(j => j.id === first.id).status, 'applied');
  store.db.prepare('UPDATE job_sources SET last_seen=? WHERE job_id=?').run('2000-01-01', first.id);
  store.ingest(source, [], { complete: false });
  assert.equal(store.jobs().find(j => j.id === first.id).active, false); assert.equal(store.jobs().find(j => j.id === first.id).status, 'applied');
});
test('every refresh re-fetches every enabled source, including already checked and newly discovered boards', async t => {
  const store = temporaryStore(t);
  store.db.prepare("UPDATE sources SET enabled=0 WHERE token='zoox'").run();
  const previousLimit = process.env.BOARD_SCAN_BATCH;
  process.env.BOARD_SCAN_BATCH = '1';
  t.after(() => { if (previousLimit === undefined) delete process.env.BOARD_SCAN_BATCH; else process.env.BOARD_SCAN_BATCH = previousLimit; });
  const calls = [];
  let version = 1;
  const refresher = createRefresher(store, { enrich: async () => {}, collector: async source => {
    calls.push(`${source.kind}:${source.token}`);
    if (source.kind === 'community') {
      const rows = [];
      rows.discoveredBoards = [{ kind: 'ashby', name: 'First', token: 'new-first' }, { kind: 'greenhouse', name: 'Second', token: 'new-second' }];
      if (version === 2) rows.discoveredBoards.push({ kind: 'ashby', name: 'Third', token: 'new-third' });
      return rows;
    }
    if (source.token === 'new-first') return [job('1234567890', { description: `Fresh description version ${version}` })];
    return [];
  } });
  t.after(() => refresher.stop());
  const assertAllChecked = () => {
    const enabled = store.sources().filter(s => s.enabled);
    assert.equal(calls.length, enabled.length);
    for (const source of enabled) assert.equal(calls.filter(key => key === `${source.kind}:${source.token}`).length, 1);
    assert.ok(!calls.includes('lever:zoox'));
  };
  await refresher.run(); assertAllChecked();
  const original = store.jobs()[0];
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(original.id, 'applied', '2026-10-21', 'Keep this note');
  calls.length = 0; version = 2; await refresher.run(); assertAllChecked();
  assert.ok(calls.includes('ashby:new-third'));
  const updated = store.jobs().find(j => j.id === original.id);
  assert.equal(updated.description, 'Fresh description version 2');
  assert.equal(updated.status, 'applied'); assert.equal(updated.note, 'Keep this note');
  assert.equal(refresher.status().scanScope, 'all_enabled_sources');
});
test('feed and HTML requests ask for fresh responses on every call', async () => {
  let revision = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    return new Response(JSON.stringify({ revision: ++revision }));
  };
  assert.equal((await fetchJson('https://example.com/feed', fetcher)).revision, 1);
  assert.equal((await fetchJson('https://example.com/feed', fetcher)).revision, 2);
  const html = await fetchSearchHtml('https://example.com/search', async (url, options) => {
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers['Cache-Control'], 'no-cache');
    return new Response('<p>Fresh results</p>');
  });
  assert.match(html, /Fresh results/);
});
test('Refresh jobs starts another collection each time and concurrent clicks share the active run', async t => {
  const store = temporaryStore(t);
  store.db.prepare("UPDATE sources SET enabled=0 WHERE kind!='linkedin'").run();
  let calls = 0, release;
  const { app, refresher } = createApp({ store, collector: async () => {
    const version = ++calls;
    await new Promise(resolve => { release = resolve; });
    return [job('1234567890', { description: `HTTP refresh version ${version}` })];
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { release?.(); refresher.stop(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const refresh = () => fetch(base + '/refresh', { method: 'POST' });
  assert.equal((await refresh()).status, 202); assert.equal(calls, 1);
  const concurrent = await (await refresh()).json();
  assert.match(concurrent.message, /already running/); assert.equal(calls, 1);
  async function finish() {
    release();
    for (let i = 0; i < 100 && refresher.status().running; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(refresher.status().running, false);
  }
  await finish(); assert.equal(store.jobs()[0].description, 'HTTP refresh version 1');
  assert.equal((await refresh()).status, 202); assert.equal(calls, 2);
  await finish(); assert.equal(store.jobs()[0].description, 'HTTP refresh version 2');
});
test('existing databases upgrade without losing job or application data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-migrate-'));
  const old = new DatabaseSync(join(directory, 'internscope.sqlite'));
  old.exec("CREATE TABLE sources(id INTEGER PRIMARY KEY,kind TEXT,name TEXT,token TEXT,enabled INTEGER DEFAULT 1,last_success TEXT,last_error TEXT,count INTEGER DEFAULT 0,UNIQUE(kind,token)); INSERT INTO sources(kind,name,token) VALUES('greenhouse','Existing','existing')");
  old.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,url TEXT UNIQUE,title TEXT,company TEXT,location TEXT,description TEXT,posted_at TEXT,date_basis TEXT,terms TEXT,years TEXT,remote INTEGER,first_seen TEXT,last_seen TEXT);
    CREATE TABLE job_sources(job_id TEXT,source_id INTEGER,active INTEGER,PRIMARY KEY(job_id,source_id));
    CREATE TABLE applications(job_id TEXT PRIMARY KEY,status TEXT,applied_at TEXT,note TEXT);
    INSERT INTO jobs VALUES('existing-job','https://example.com/existing','Existing Intern','Existing','Remote','Python',NULL,'unknown','[]','[]',1,'2026-10-01','2026-10-20');
    INSERT INTO job_sources VALUES('existing-job',1,1);
    INSERT INTO applications VALUES('existing-job','applied','2026-10-21','Keep this application note');`);
  old.close();
  const store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.sources().find(s => s.token === 'existing').origin, 'manual');
  assert.ok(store.sources().some(s => s.kind === 'linkedin'));
  assert.equal(store.jobs().find(j => j.id === 'existing-job').status, 'applied');
  assert.equal(store.jobs().find(j => j.id === 'existing-job').note, 'Keep this application note');
  assert.equal(store.db.prepare("SELECT last_seen FROM job_sources WHERE job_id='existing-job'").get().last_seen, '2026-10-20');
});
test('integration credentials stay server-side and platform filtering works', async t => {
  const store = temporaryStore(t), source = store.sources().find(s => s.kind === 'linkedin');
  store.ingest(source, [job('1234567890')], { complete: false });
  const { app, refresher } = createApp({ store });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { refresher.stop(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const key = 'test-only-secret-key-1234567890';
  const response = await fetch(base + '/integrations/serpapi', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
  assert.equal(response.status, 200);
  const snapshot = await (await fetch(base + '/state')).json();
  assert.equal(snapshot.integrations.serpapi.configured, true); assert.ok(!JSON.stringify(snapshot).includes(key));
  assert.equal((await (await fetch(base + '/jobs?platform=linkedin')).json()).total, 1);
  assert.equal((await (await fetch(base + '/jobs?platform=ashby')).json()).total, 0);
  const clear = await fetch(base + '/integrations/serpapi', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) });
  assert.equal(clear.status, 200); assert.equal(store.setting('serpapi_key'), '');
});
