import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRunway, collectInternList, parseRunway, parseInternList, parseInternListPage, requestPublicJson } from '../server/aggregators.js';
import { openStore } from '../server/db.js';
import { createRefresher } from '../server/refresh.js';
import { scoreJob } from '../server/matching.js';

const wrap = value => ({ result: { data: { json: value } } });
const runwayRow = (id = 'example-1', extra = {}) => ({ id, jobType: 'JOB_POSTING', title: 'Software Engineering Intern — Summer 2027', company: 'Example Labs', applyUrl: `https://job-boards.greenhouse.io/example/jobs/${id}?utm_source=runway`, postedAt: '2026-10-20T10:00:00.000Z', seniorityLevel: 'INTERNSHIP', location: 'Los Angeles, CA', workArrangement: 'REMOTE_OK', matchScore: 97, ...extra });
const internRow = (id = 'abcd1234', region = 'us', extra = {}) => ({ jobId: id, tabCategory: [`intern:${region}:engineering_development`], postedAt: 1792490400000, properties: { title: 'Mechanical Engineering Intern — Summer 2027', company: 'Example Manufacturing', location: region === 'ca' ? 'Toronto, Canada' : 'Los Angeles, CA', qualifications: 'Python, MATLAB, mechanical engineering and CAD.', salary: '$25/hr', workModel: 'Remote', industry: ['Manufacturing'], isNewGrad: false, hireTime: '2027-Summer', ...extra } });
test('Runway records use original job links and source dates, not Runway match scores', () => {
  const jobs = parseRunway(wrap({ jobs: [runwayRow(), runwayRow('internal', { title: 'Internal Finance Analyst', seniorityLevel: 'FULL_TIME' }), runwayRow('project', { jobType: 'PROJECT' })], nextCursor: null }));
  assert.equal(jobs.length, 1); assert.equal(jobs[0].url, 'https://job-boards.greenhouse.io/example/jobs/example-1');
  assert.equal(jobs[0].remote, true); assert.equal(jobs[0].dateBasis, 'listing');
  assert.equal(jobs[0].postedAt, '2026-10-20T10:00:00.000Z'); assert.equal(jobs[0].matchScore, undefined);
  assert.throws(() => parseRunway({ error: { message: 'Unauthorized' } }), /public listing access/);
});
test('Runway follows observed cursor pagination and enriches a bounded set of public descriptions', async () => {
  const inputs = [];
  const result = await collectRunway({ pages: 3, details: 1, pause: async () => {}, request: async url => {
    const parsed = new URL(url), envelope = JSON.parse(parsed.searchParams.get('input')), input = envelope.json;
    if (input.cursor) assert.deepEqual(envelope.meta.values['cursor.lastPostedAt'], ['Date']);
    inputs.push(input);
    if (parsed.pathname.endsWith('getJobPostingById')) return wrap({ descriptionHtml: '<p>Build Python and SQL systems in a paid summer internship.</p>' });
    if (input.filters.employmentType === 'CO_OP') return wrap({ jobs: [], nextCursor: null });
    if (input.cursor) return wrap({ jobs: [runwayRow('second')], nextCursor: null });
    return wrap({ jobs: [runwayRow()], nextCursor: { lastId: 'example-1', lastPostedAt: '2026-10-20T10:00:00.000Z' } });
  } });
  assert.equal(result.jobs.length, 2); assert.equal(inputs[1].cursor.lastId, 'example-1');
  assert.equal(inputs[0].filters.employmentType, 'INTERNSHIP');
  assert.ok(inputs.some(input => input.filters?.employmentType === 'CO_OP'));
  assert.equal(result.complete, true); assert.match(result.jobs[0].description, /Python and SQL/);
});
test('Runway retains partial results when later pages fail and does not request more pages', async () => {
  let calls = 0;
  const result = await collectRunway({ pages: 5, details: 0, pause: async () => {}, request: async () => {
    if (calls++) throw new Error('HTTP 429');
    return wrap({ jobs: [runwayRow()], nextCursor: { lastId: 'example-1', lastPostedAt: '2026-10-20T10:00:00.000Z' } });
  } });
  assert.equal(calls, 2); assert.equal(result.jobs.length, 1); assert.equal(result.complete, false); assert.match(result.warnings[0], /429/);
});
test('Intern List engineering metadata keeps geography, hiring term and stable posting links', () => {
  const jobs = parseInternList({ success: true, result: { total: 3, jobList: [internRow(), internRow('newgrad', 'us', { isNewGrad: true }), internRow('senior', 'us', { expLevel: 5 })] } });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].url, 'https://jobright.ai/jobs/info/abcd1234');
  assert.equal(jobs[0].dateBasis, 'listing'); assert.equal(jobs[0].remote, true);
  assert.deepEqual(jobs[0].terms, ['summer']); assert.deepEqual(jobs[0].years, ['2027']);
  assert.match(jobs[0].description, /Qualifications/); assert.match(jobs[0].description, /\$25\/hr/);
  assert.equal(scoreJob(jobs[0], { resume: 'Engineering student with Python MATLAB CAD and mechanical engineering experience.' }).confidence, 'limited');
  assert.equal(parseInternList({ result: { total: 1, jobList: [internRow('ca', 'ca')] } }, 'us').length, 0);
  assert.throws(() => parseInternList({ success: false }), /public listing access/);
});
test('Intern List requests public engineering categories with advancing positions for both regions', async () => {
  const requests = [];
  const result = await collectInternList({ pages: 3, pause: async () => {}, request: async (url, options) => {
    const parsed = new URL(url), region = options.body.category.split(':')[1], position = Number(parsed.searchParams.get('position'));
    requests.push({ url: parsed, options });
    if (region === 'ca') return { result: { total: 1, jobList: [internRow('canadian', 'ca')] } };
    return { result: { total: 2, jobList: [internRow(position ? 'second' : 'first')] } };
  } });
  assert.equal(result.jobs.length, 3); assert.equal(result.complete, true);
  assert.equal(requests[0].options.method, 'POST'); assert.equal(requests[1].url.searchParams.get('position'), '1');
  assert.equal(requests[0].options.body.category, 'intern:us:engineering_development');
  assert.equal(requests[2].options.body.category, 'intern:ca:engineering_development');
});
test('bounded recent-page searches never treat the unvisited catalog as closed', async () => {
  const result = await collectInternList({ pages: 1, pause: async () => {}, request: async (url, options) => {
    const region = options.body.category.split(':')[1];
    return { result: { total: 500, jobList: [internRow(region, region)] } };
  } });
  assert.equal(result.complete, false); assert.equal(result.jobs.length, 2); assert.match(result.warnings[0], /older listings may remain/);
});
test('public embedded Intern List tables can be parsed without executing their scripts', () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialTotal: 1, initialJobs: [{ id: 'abcd1234', postedDate: 1792490400000, ...internRow().properties }], pathInfo: { country: 'us' } } } })}</script>`;
  assert.equal(parseInternListPage(html)[0].title, internRow().properties.title);
  assert.throws(() => parseInternListPage('<h1>Sign in</h1>'), /readable public job table/);
});
test('public POST searches bypass caching and contain only query data', async () => {
  let captured;
  const data = await requestPublicJson('https://jobright.ai/swan/mini-sites/list?position=0&count=50', { method: 'POST', body: { category: 'intern:us:engineering_development' } }, async (url, options) => {
    captured = options; return new Response('{"result":{"jobList":[],"total":0}}');
  });
  assert.equal(captured.method, 'POST'); assert.equal(captured.cache, 'no-store');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.body), { category: 'intern:us:engineering_development' });
  assert.equal(data.result.total, 0);
});
test('new sources join every refresh, preserve applied jobs, and discover additional ATS boards', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-aggregators-')), store = openStore(directory);
  const visited = [];
  store.db.prepare("UPDATE sources SET enabled=0 WHERE kind NOT IN ('runway','internlist')").run();
  const refresher = createRefresher(store, { enrich: async () => {}, collector: async source => {
    visited.push(source.kind);
    return source.kind === 'runway' ? { jobs: parseRunway(wrap({ jobs: [runwayRow('123')], nextCursor: null })), complete: false } : { jobs: [], complete: false };
  } });
  t.after(() => { refresher.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await refresher.run();
  assert.ok(visited.includes('runway')); assert.ok(visited.includes('internlist')); assert.ok(visited.includes('greenhouse'));
  const first = store.jobs()[0];
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(first.id, 'applied', '2026-10-21', 'Keep my notes');
  visited.length = 0; await refresher.run();
  assert.ok(visited.includes('runway')); assert.ok(visited.includes('internlist'));
  assert.equal(store.jobs()[0].status, 'applied'); assert.equal(store.jobs()[0].note, 'Keep my notes');
  store.db.prepare("UPDATE sources SET enabled=0 WHERE kind='runway'").run();
  // Migration runs once: opening the app again must not silently re-enable a disabled source.
  const second = openStore(directory); assert.equal(second.sources().find(s => s.kind === 'runway').enabled, 0); second.close();
});
