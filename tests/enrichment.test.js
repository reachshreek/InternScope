import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, DEFAULT_PROFILE } from '../server/db.js';
import { createEnricher } from '../server/enrichment.js';
import { descriptionQuality, compatiblePosition } from '../server/quality.js';
import { publicAddress, validatePublicUrl, extractPublicDescription, fetchJobDescription, DetailError } from '../server/detail-fetch.js';
import { createApp } from '../server/index.js';

const full = 'A full engineering internship description. Build reliable software using Python, SQL, React and Git. Collaborate with design and engineering teams, test your code, document your experiments and learn from experienced engineers. Applicants should be enrolled in computer science or a related degree and have experience with practical programming projects.';
const job = (id, extra = {}) => ({ title: `Software Engineering Intern ${id}`, company: 'Example Labs', location: 'Los Angeles, CA', url: `https://jobs.example.com/${id}`, description: '', terms: ['summer'], years: ['2027'], ...extra });
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-details-')), store = openStore(directory), workers = [];
  t.after(async () => { for (const worker of workers) worker.stop(); await Promise.all(workers.map(worker => worker.drain())); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, worker(options = {}) { const worker = createEnricher(store, { hostDelayMs: 0, intervalMs: 1e6, ...options }); workers.push(worker); return worker; } };
}
test('description classes distinguish title, summary, and full text', () => {
  assert.equal(descriptionQuality({ description: '' }), 'title');
  assert.equal(descriptionQuality({ description: 'Use Python.' }), 'summary');
  assert.equal(descriptionQuality({ description: `Listing summary. ${full}` }), 'summary');
  assert.equal(descriptionQuality({ description: full }), 'full');
});
test('summary imports cannot downgrade full descriptions or lose notes/provenance', t => {
  const { store } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('1', { description: full, detailRefs: [{ kind: 'runway', externalId: 'runway-job-1' }] })]);
  const first = store.jobs()[0];
  assert.equal(store.detailRefs(first.id).length, 1, 'Reference should be saved on first insert');
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(first.id, 'applied', '2026-10-23', 'My notes');
  store.ingest(source, [job('1', { description: 'Listing summary. Use Python.' })]);
  const result = store.job(first.id);
  assert.equal(result.description, full); assert.equal(result.descriptionQuality, 'full');
  assert.equal(result.note, 'My notes'); assert.equal(result.status, 'applied');
  assert.equal(result.descriptionFetchedAt, first.descriptionFetchedAt); assert.equal(store.detailRefs(first.id)[0].externalId, 'runway-job-1');
});
test('full descriptions share across exact unambiguous positions and update from their donor', t => {
  const { store, worker } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('a', { title: 'Design Intern 2027', description: full }), job('b', { title: 'Design Intern 2027', description: 'Listing summary. Design work.' })]);
  const service = worker(); assert.equal(service.share(), 1);
  const target = store.jobs().find(j => j.url.endsWith('/b'));
  assert.equal(target.descriptionQuality, 'full'); assert.equal(target.descriptionMethod, 'shared');
  assert.equal(target.descriptionUrl, 'https://jobs.example.com/a');
  assert.equal(service.share(), 0);
  store.ingest(source, [job('a', { title: 'Design Intern 2027', description: full + ' Updated responsibilities.' }), job('b', { title: 'Design Intern 2027', description: 'Listing summary. Design work.' })]);
  assert.equal(service.share(), 1); assert.match(store.job(target.id).description, /Updated responsibilities/);
});
test('ambiguous positions, different years and broad remote locations do not share', t => {
  const { store, worker } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('a', { title: 'Intern', description: full }), job('b', { title: 'Intern', description: full + ' Different opening.' }), job('c', { title: 'Intern' }), job('d', { title: 'Remote Intern', location: 'Remote', description: full }), job('e', { title: 'Remote Intern', location: 'Remote' })]);
  assert.equal(worker().share(), 0);
  assert.equal(compatiblePosition({ years: ['2026'], terms: [] }, { years: ['2027'], terms: [] }), false);
});
test('the queue progresses past previously fetched jobs and persists progress', async t => {
  const { store, worker, directory } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('1'),job('2'),job('3')]);
  const visited = [];
  const service = worker({ batchSize: 1, resolver: async item => { visited.push(item.id); return { description: full, url: item.url, method: 'test' }; } });
  await service.run(); await service.run();
  assert.equal(new Set(visited).size, 2); assert.equal(service.status().counts.done, 2);
  const reopened = openStore(directory);
  assert.equal(reopened.db.prepare("SELECT count(*) count FROM enrichment_queue WHERE state='done'").get().count, 2); reopened.close();
  await service.run(); assert.equal(new Set(visited).size, 3); assert.equal(service.status().counts.done, 3);
});
test('relevant saved jobs are prioritized over unrelated jobs', async t => {
  const { store, worker } = setup(t), source = store.sources()[0];
  store.saveProfile({ ...DEFAULT_PROFILE, resume: 'Python developer with React and SQL projects.', locations: 'California', roles: 'Software' });
  store.ingest(source, [job('unrelated', { title: 'Finance Intern', location: 'New York' }), job('target', { location: 'California' })]);
  const target = store.jobs().find(j => j.url.endsWith('/target'));
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(target.id, 'saved', null, '');
  const visited = [];
  await worker({ batchSize: 1, resolver: async item => { visited.push(item.id); return { description: full, url: item.url }; } }).run();
  assert.equal(visited[0], target.id);
});
test('a changed posting title invalidates an old cached description and requeues it', async t => {
  const { store, worker } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('1')]); const service = worker({ resolver: async item => ({ description: full, url: item.url }) });
  await service.run(); const first = store.jobs()[0]; assert.equal(first.descriptionQuality, 'full');
  store.ingest(source, [job('1', { title: 'Hardware Engineering Intern 2028' })]);
  assert.equal(store.job(first.id).descriptionQuality, 'title');
  service.sync(); assert.equal(service.jobStatus(first.id).state, 'pending');
});

test('different feed titles and punctuation changes preserve cached descriptions across refreshes', t => {
  const { store } = setup(t), [community, employer] = store.sources();
  store.ingest(community, [job('1', { title: 'Software Intern', description: '' })]);
  store.ingest(employer, [job('1', { title: 'Summer 2027: Software Intern', description: full })]);
  const id = store.jobs()[0].id;
  store.ingest(community, [job('1', { title: 'Software Intern', description: '' })]);
  assert.equal(store.job(id).description, full);
  store.ingest(employer, [job('1', { title: 'Summer 2027 - Software Intern', description: '' })]);
  assert.equal(store.job(id).descriptionQuality, 'full');
});
test('rate limits pause the host and repeated runs do not hammer it', async t => {
  const { store, worker } = setup(t), source = store.sources()[0]; let current = Date.now(), calls = 0;
  store.ingest(source, [job('1'),job('2')]);
  const service = worker({ batchSize: 1, now: () => current, resolver: async item => { calls++; if (calls === 1) throw new DetailError('Rate limited.', { status: 429, host: 'jobs.example.com', retryAfter: current + 3600000 }); return { description: full, url: item.url }; } });
  await service.run(); assert.equal(calls, 1);
  await service.run(); assert.equal(calls, 1); assert.equal(service.status().cooldowns.length, 1);
  current += 3600001; await service.run(); assert.ok(calls > 1);
});
test('opening a job deduplicates concurrent detail requests and preserves applied history', async t => {
  const { store, worker } = setup(t), source = store.sources()[0]; let calls = 0, finish;
  store.ingest(source, [job('1')]); const first = store.jobs()[0];
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(first.id, 'applied', '2026-10-23', 'Application notes');
  const service = worker({ resolver: async item => { calls++; await new Promise(resolve => { finish = resolve; }); return { description: full, url: item.url }; } });
  service.start(); service.request(first.id); service.request(first.id);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  finish(); await service.drain();
  assert.equal(store.job(first.id).descriptionQuality, 'full'); assert.equal(store.job(first.id).status, 'applied'); assert.equal(store.job(first.id).note, 'Application notes');
});
test('private addresses, custom ports, credentials, mixed DNS answers and non-HTTPS URLs are rejected', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','169.254.169.254','192.168.1.2','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  const dns = async () => [{ address: '8.8.8.8', family: 4 }];
  for (const url of ['http://example.com/job','https://127.0.0.1/job','https://example.com:8443/job','https://user:pass@example.com/job','https://localhost/job']) await assert.rejects(() => validatePublicUrl(url, dns));
  await assert.rejects(() => validatePublicUrl('https://example.com/job', async () => [{ address: '8.8.8.8', family: 4 },{ address: '127.0.0.1', family: 4 }]));
  assert.equal((await validatePublicUrl('https://example.com/job', dns)).url.hostname, 'example.com');
});
test('structured description extraction binds to the requested title and rejects generic body text', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Software Intern', description: `<p>${full}</p>` })}</script>`;
  assert.equal(extractPublicDescription(html, { title: 'Software Intern' }, 'https://example.com/job').description, full);
  assert.equal(extractPublicDescription(html, { title: 'Accounting Intern' }, 'https://example.com/job'), null);
  assert.equal(extractPublicDescription(`<body>${full.repeat(5)}</body>`, { title: 'Software Intern' }, 'https://example.com/job'), null);
});
test('known employer and Runway readers use public full-description endpoints', async () => {
  const requests = [];
  const reader = async url => { requests.push(url); return { url, body: JSON.stringify(url.includes('/wday/cxs/') ? { jobPostingInfo: { jobDescription: full } } : url.includes('greenhouse') ? { content: `<p>${full}</p>` } : { result: { data: { json: { descriptionHtml: `<p>${full}</p>` } } } }) }; };
  const gh = await fetchJobDescription(job('1', { url: 'https://job-boards.greenhouse.io/acme/jobs/123' }), [], { request: reader });
  assert.equal(gh.method, 'employer-api');
  const wd = await fetchJobDescription(job('2', { url: 'https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/City/Intern_R123' }), [], { request: reader });
  assert.equal(wd.method, 'employer-workday-api'); assert.ok(requests.some(url => url.includes('/wday/cxs/acme/Careers/job/City/Intern_R123')));
  const runway = await fetchJobDescription(job('3'), [{ kind: 'runway', externalId: 'job-123' }], { request: reader });
  assert.equal(runway.method, 'runway-public-details');
});
test('full-description filtering and on-demand endpoints return updated quality and provenance', async t => {
  const { store } = setup(t), source = store.sources()[0];
  store.ingest(source, [job('full', { description: full }), job('summary', { description: 'Listing summary. Python projects.' }), job('title')]);
  const { app, enricher, refresher } = createApp({ store, enrichmentOptions: { intervalMs: 1e6, resolver: async item => ({ description: full, url: item.url, method: 'test' }) } });
  enricher.start();
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => { enricher.stop(); refresher.stop(); await enricher.drain(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const quality of ['full','summary','title']) assert.equal((await (await fetch(`${base}/jobs?quality=${quality}`)).json()).total, 1);
  const title = store.jobs().find(j => j.url.endsWith('/title'));
  await fetch(`${base}/jobs/${title.id}/enrich`, { method: 'POST' }); await enricher.drain();
  const result = await (await fetch(`${base}/jobs/${title.id}`)).json();
  assert.equal(result.job.match.quality, 'full'); assert.equal(result.job.descriptionUrl, title.url);
  assert.equal((await (await fetch(`${base}/jobs?quality=full`)).json()).total, 2);
});
