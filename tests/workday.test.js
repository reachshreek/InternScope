import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boardFromUrl, normalizeBoardToken, boardApi } from '../server/boards.js';
import { collectWorkday, parseWorkday } from '../server/workday.js';
import { discoverBoards } from '../server/discovery.js';
import { collectSource } from '../server/providers.js';
import { fetchJobDescription } from '../server/detail-fetch.js';
import { postingIdentity } from '../server/posting-identity.js';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';

const source = { kind: 'workday', name: 'Example', token: 'example.wd501.myworkdayjobs.com/External' };
const row = (id = 1, title = 'Software Engineering Intern') => ({ title, externalPath: `/job/US-CA-Santa-Clara/Software-Intern_JR${id}`, locationsText: 'Santa Clara, CA', postedOn: 'Posted Today' });
const page = (rows = [], total = rows.length, facets = []) => ({ jobPostings: rows, total, facets });
const facet = [{ facetParameter: 'workerSubType', values: [{ descriptor: 'Intern (Fixed Term)', id: 'intern-id' }, { descriptor: 'Regular', id: 'regular-id' }] }];
const noPause = async () => {};
const full = 'Build useful software with Python, SQL and C++. Collaborate with engineering teams, document your experiments and test reliable systems. This internship is open to students pursuing computer science or a related degree. Develop your technical skills while learning from experienced mentors. '.repeat(2);
function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-workday-'));
  const store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

test('discovery recognizes Workday locales, Lever regions and dotted Ashby boards', () => {
  const boards = discoverBoards([
    { url: 'https://example.wd501.myworkdayjobs.com/en-US/External/job/US/Intern_JR1', company: 'Example' },
    { url: 'https://example.wd501.myworkdayjobs.com/External/job/US/Intern_JR2' },
    { url: 'https://jobs.eu.lever.co/cirrus/abc', company: 'Cirrus' },
    { url: 'https://jobs.lever.co/cirrus/abc' },
    { url: 'https://jobs.ashbyhq.com/rivianvw.tech/abc' },
    { url: 'https://boards.eu.greenhouse.io/acme/jobs/1' }
  ]);
  assert.equal(boards.length, 5);
  assert.equal(boards[0].token, source.token);
  assert.equal(boards[1].token, 'cirrus@eu');
  assert.equal(boards[2].token, 'cirrus');
  assert.equal(boards[3].token, 'rivianvw.tech');
  assert.equal(boards[4].token, 'acme@eu');
  assert.equal(boardApi(boards[1]).url, 'https://api.eu.lever.co/v0/postings/cirrus');
});

test('board identifiers cannot introduce arbitrary hosts, credentials or path traversal', () => {
  for (const url of [
    'https://jobs.lever.co.evil.com/acme/1', 'https://example.wd5.myworkdayjobs.com.evil.com/External',
    'https://jobs.lever.co:444/acme/1', 'https://user:password@jobs.lever.co/acme/1',
    'https://example.wd5.myworkdayjobs.com/External%2F..%2Fevil/job/1',
    'https://jobs.lever.co/acme%2f..%2fother/1', 'http://jobs.lever.co/acme/1'
  ]) assert.equal(boardFromUrl(url), null, url);
  for (const token of ['localhost/External', 'example.wd5.myworkdayjobs.com/../jobs', 'example.wd5.myworkdayjobs.com/External/other']) {
    assert.equal(normalizeBoardToken('workday', token), null, token);
  }
  assert.equal(normalizeBoardToken('lever', 'https://jobs.eu.lever.co/cirrus/123'), 'cirrus@eu');
  assert.equal(normalizeBoardToken('workday', 'https://example.wd501.myworkdayjobs.com/en-US/External'), source.token);
  assert.equal(normalizeBoardToken('ashby', 'rivianvw.tech'), 'rivianvw.tech');
});

test('Workday uses internship facets and advances by actual page length through all results', async () => {
  const requests = [];
  const result = await collectWorkday(source, { pause: noPause, request: async (url, body) => {
    requests.push({ url, body });
    if (body.limit === 1) return page([], 3, facet);
    assert.deepEqual(body.appliedFacets, { workerSubType: ['intern-id'] });
    assert.equal(body.searchText, '');
    return body.offset === 0 ? page([row(1), row(2, 'Product Design Placement')], 3) : page([row(3)], 3);
  } });
  assert.equal(result.jobs.length, 3); assert.equal(result.complete, true);
  assert.deepEqual(requests.map(r => r.body.offset), [0, 0, 2]);
  assert.ok(requests.every(r => r.url === 'https://example.wd501.myworkdayjobs.com/wday/cxs/example/External/jobs'));
  assert.ok(result.jobs[0].postedAt); assert.equal(result.jobs[0].dateBasis, 'estimated');
  assert.equal(result.jobs[0].descriptionQuality, 'title');
});

test('without facets Workday checks both intern and co-op queries and excludes senior fuzzy matches', async () => {
  const queries = [];
  const result = await collectWorkday(source, { pause: noPause, request: async (url, body) => {
    if (body.limit === 1) return page();
    queries.push(body.searchText);
    return body.searchText === 'intern' ? page([row(1), row(2, 'Senior Engineer')]) : page([row(3, 'Engineering Co-op'), row(1)]);
  } });
  assert.deepEqual(queries, ['intern', 'co-op']); assert.equal(result.jobs.length, 2);
  assert.equal(result.complete, false); assert.match(result.warnings.join(' '), /partial coverage/);
});

test('Workday page caps and repeated pages retain partial results instead of closing unseen jobs', async () => {
  for (const repeated of [false, true]) {
    const result = await collectWorkday(source, { pause: noPause, pages: repeated ? 5 : 1, request: async (url, body) => body.limit === 1 ? page([], 50, facet) : page([row(1)], 50) });
    assert.equal(result.jobs.length, 1); assert.equal(result.complete, false);
    assert.match(result.warnings.join(' '), repeated ? /repeated/ : /page limit/);
  }
});

test('Workday keeps the first-page total when later pages report only their own window size', async () => {
  const offsets = [];
  const result = await collectWorkday(source, { pause: noPause, request: async (url, body) => {
    if (body.limit === 1) return page([], 3, facet);
    offsets.push(body.offset);
    return page([row(body.offset + 1)], body.offset === 0 ? 3 : 1);
  } });
  assert.deepEqual(offsets, [0, 1, 2]);
  assert.equal(result.jobs.length, 3); assert.equal(result.complete, true);
});

test('Workday source failures are visible, and later page failures preserve completed pages', async () => {
  await assert.rejects(() => collectWorkday(source, { request: async () => { throw new Error('HTTP 403'); } }), /403/);
  await assert.rejects(() => collectWorkday(source, { request: async () => ({ total: 0 }) }), /invalid listing/);
  let calls = 0;
  const result = await collectWorkday(source, { pause: noPause, request: async () => {
    if (++calls === 1) return page([], 3, facet);
    if (calls === 2) return page([row(1)], 3);
    throw new Error('HTTP 429');
  } });
  assert.equal(calls, 3); assert.equal(result.jobs.length, 1); assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /429/);
});

test('Workday rejects off-site listing paths and uses primary location for multi-location cards', () => {
  const data = page([row(), { ...row(2), externalPath: '//evil.com/job/2' }, { ...row(3), externalPath: '/job/../../other' }, { ...row(4), locationsText: '3 Locations' }]);
  const jobs = parseWorkday(data, source);
  assert.equal(jobs.length, 2);
  assert.match(jobs[1].location, /US CA Santa Clara/);
  assert.ok(jobs.every(j => new URL(j.url).hostname === 'example.wd501.myworkdayjobs.com'));
});

test('European ATS collection and description readers use the correct API region', async () => {
  const requests = [];
  await collectSource({ kind: 'lever', token: 'cirrus@eu', name: 'Cirrus' }, async url => { requests.push(url); return []; });
  await collectSource({ kind: 'greenhouse', token: 'acme@eu', name: 'Acme' }, async url => { requests.push(url); return { jobs: [] }; });
  assert.deepEqual(requests, ['https://api.eu.lever.co/v0/postings/cirrus?mode=json', 'https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs']);
  const result = await fetchJobDescription({ title: 'Software Intern', url: 'https://jobs.eu.lever.co/cirrus/abc/apply' }, [], { request: async url => {
    assert.equal(url, 'https://api.eu.lever.co/v0/postings/cirrus/abc');
    return { body: JSON.stringify({ descriptionPlain: full }), url };
  } });
  assert.equal(result.descriptionQuality, 'full');
});

test('Workday listings feed the existing public description reader', async () => {
  const job = parseWorkday(page([row(1)]), source)[0];
  const result = await fetchJobDescription(job, [], { request: async url => {
    assert.equal(url, 'https://example.wd501.myworkdayjobs.com/wday/cxs/example/External/job/US-CA-Santa-Clara/Software-Intern_JR1');
    return { body: JSON.stringify({ jobPostingInfo: { jobDescription: `<p>${full}</p>` } }), url };
  } });
  assert.equal(result.method, 'employer-workday-api'); assert.equal(result.descriptionQuality, 'full');
});

test('stable ATS identities recognize aliases and keep different requisitions separate', () => {
  const same = [
    ['https://boards.greenhouse.io/acme/jobs/123?gh_src=x', 'https://job-boards.greenhouse.io/acme/jobs/123'],
    ['https://acme.com/careers?gh_jid=123', 'https://boards.greenhouse.io/embed/job_app?for=acme&token=123'],
    ['https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111/apply', 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111'],
    ['https://example.wd5.myworkdayjobs.com/en-US/External/job/US/Intern_JR123', 'https://example.wd5.myworkdayjobs.com/External/job/Other/Updated-Intern_JR123']
  ];
  for (const [a, b] of same) { assert.ok(postingIdentity(a)); assert.equal(postingIdentity(a), postingIdentity(b)); }
  assert.notEqual(postingIdentity('https://boards.greenhouse.io/acme/jobs/123'), postingIdentity('https://boards.greenhouse.io/acme/jobs/124'));
  assert.equal(postingIdentity('https://evil.com/greenhouse.io/acme/jobs/123'), null);
});

test('ATS alias ingestion preserves application IDs, notes, original dates and richer descriptions', t => {
  const store = temporaryStore(t), sources = store.sources();
  const job = { title: 'Software Intern', company: 'Acme', location: 'Boston', url: 'https://acme.com/careers?gh_jid=123', description: full, postedAt: '2026-10-01', dateBasis: 'published' };
  store.ingest(sources[0], [job]);
  const original = store.jobs()[0];
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(original.id, 'applied', '2026-10-02', 'Interview scheduled');
  store.ingest(sources[1], [{ ...job, description: '', url: 'https://job-boards.greenhouse.io/acme/jobs/123', postedAt: '2026-10-27' }]);
  assert.equal(store.jobs().length, 1);
  const after = store.job(original.id);
  assert.equal(after.status, 'applied'); assert.equal(after.note, 'Interview scheduled');
  assert.equal(after.firstSeen, original.firstSeen); assert.equal(after.postedAt, original.postedAt);
  assert.equal(after.description, full);
  assert.equal(store.db.prepare('SELECT count(*) n FROM job_sources WHERE job_id=?').get(original.id).n, 2);
  store.ingest(sources[1], [{ ...job, url: 'https://job-boards.greenhouse.io/acme/jobs/124' }]);
  assert.equal(store.jobs().length, 2);
});

test('Workday source setup is idempotent and preserves disabled choices on restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-workday-upgrade-'));
  let store = openStore(directory);
  const original = store.sources().find(s => s.kind === 'workday');
  assert.equal(store.sources().filter(s => s.kind === 'workday').length, 4);
  store.db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run(original.id);
  store.close(); store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.sources().filter(s => s.kind === 'workday').length, 4);
  assert.equal(store.sources().find(s => s.id === original.id).enabled, 0);
});

test('identity migration preserves existing duplicate histories and reuses unambiguous old IDs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-identity-upgrade-'));
  let store = openStore(directory);
  const source = store.sources()[0];
  const job = id => ({ title: 'Software Intern', company: 'Acme', url: `https://boards.greenhouse.io/acme/jobs/${id}`, description: '' });
  store.ingest(source, [job(123), job(124), job(125)]);
  const originals = store.jobs();
  const first = originals.find(j => j.url.endsWith('/123')), second = originals.find(j => j.url.endsWith('/124'));
  const unique = originals.find(j => j.url.endsWith('/125'));
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(first.id, 'applied', '2026-10-01', 'First history');
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(second.id, 'saved', null, 'Second history');
  store.db.prepare('UPDATE jobs SET url=? WHERE id=?').run('https://job-boards.greenhouse.io/acme/jobs/123', second.id);
  store.db.exec('DROP INDEX jobs_posting_identity; ALTER TABLE jobs DROP COLUMN posting_identity');
  store.close(); store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.job(first.id).note, 'First history');
  assert.equal(store.job(second.id).note, 'Second history');
  assert.equal(store.job(first.id).status, 'applied');
  assert.equal(store.job(second.id).status, 'saved');
  store.ingest(source, [{ ...job(125), url: 'https://acme.com/careers?gh_jid=125' }]);
  assert.equal(store.jobs().length, 3); assert.ok(store.job(unique.id));
  store.ingest(source, [{ ...job(123), url: 'https://acme.com/careers?gh_jid=123' }]);
  assert.equal(store.jobs().length, 4);
  assert.equal(store.job(first.id).note, 'First history'); assert.equal(store.job(second.id).note, 'Second history');
});

test('source API accepts Workday careers URLs and exposes Workday and Lever coverage', async t => {
  const store = temporaryStore(t), { app, refresher } = createApp({ store });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { refresher.stop(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const add = token => fetch(`${base}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'workday', name: 'Example', token }) });
  assert.equal((await add('https://example.wd501.myworkdayjobs.com/en-US/External')).status, 201);
  assert.equal((await add(source.token)).status, 409);
  assert.equal((await add('https://evil.com/External')).status, 400);
  const snapshot = await (await fetch(`${base}/state`)).json();
  assert.ok(snapshot.coverage.some(c => c.kind === 'workday'));
  assert.ok(snapshot.coverage.some(c => c.kind === 'lever'));
  assert.equal(store.discover([{ kind: 'lever', token: 'cirrus@eu' }]), 1);
  assert.equal(store.discover([{ kind: 'workday', token: source.token }]), 0);
});
