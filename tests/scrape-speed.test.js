import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.js';
import { createRefresher } from '../server/refresh.js';
import { createEnricher } from '../server/enrichment.js';
import { collectSource } from '../server/providers.js';
import { fetchJobDescription } from '../server/detail-fetch.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const full = 'Build reliable software using Python, SQL, React and Git. Collaborate with design and engineering teams, test your code, document your experiments and learn from experienced engineers. Applicants should be enrolled in computer science or a related degree and have experience with practical programming projects.';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-speed-')), store = openStore(directory);
  store.db.prepare('UPDATE sources SET enabled=0').run();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
function add(store, kind, token) {
  store.db.prepare("INSERT INTO sources(kind,token,name,origin) VALUES (?,?,?,'discovered')").run(kind, token, token);
}

test('parallel scans bypass slow platforms, respect host limits and include late discoveries exactly once', async t => {
  const store = setup(t);
  store.db.prepare("UPDATE sources SET enabled=1 WHERE kind IN ('community','runway','indeed')").run();
  for (let i = 0; i < 24; i++) add(store, 'workday', `company${i}.wd1.myworkdayjobs.com/Careers`);
  add(store, 'workday', 'company0.wd1.myworkdayjobs.com/OtherSite');
  for (let i = 0; i < 12; i++) add(store, 'greenhouse', `speed${i}`);
  let active = 0, peak = 0, platformDone = false, boardsBeforePlatform = 0;
  const hosts = new Map(), visited = [];
  const service = createRefresher(store, { backgroundDetails: true, collector: async source => {
    assert.equal(source.searchOptions.details, 0);
    visited.push(source.id);
    const host = source.kind === 'workday' ? source.token.split('/')[0] : source.kind;
    hosts.set(host, (hosts.get(host) || 0) + 1);
    assert.ok(hosts.get(host) <= (source.kind === 'workday' ? 1 : 4));
    peak = Math.max(peak, ++active);
    if (source.kind === 'workday' && !platformDone) boardsBeforePlatform++;
    await pause(['community','runway','indeed'].includes(source.kind) ? 70 : 10);
    if (source.kind === 'indeed') platformDone = true;
    active--; hosts.set(host, hosts.get(host) - 1);
    const rows = [];
    if (['community','runway'].includes(source.kind)) rows.discoveredBoards = [{ kind: 'ashby', name: 'Late discovery', token: 'late-speed-board' }];
    return rows;
  } });
  t.after(() => service.stop());
  await service.run();
  assert.equal(peak, 16);
  assert.ok(boardsBeforePlatform >= 13);
  assert.equal(visited.length, new Set(visited).size);
  assert.equal(visited.length, store.sources().filter(s => s.enabled).length);
  assert.equal(service.status().progress.checked, service.status().progress.total);
  assert.equal(service.status().progress.discovered, 1);
  assert.deepEqual(service.status().last.errors, []);
});

test('interrupted scans resume completed boards and failures, then a new refresh checks everything again', async t => {
  const store = setup(t), calls = [];
  for (let i = 0; i < 8; i++) add(store, 'ashby', `resume${i}`);
  let first;
  first = createRefresher(store, { concurrency: 1, collector: async source => {
    calls.push(source.id);
    if (calls.length === 1) throw new Error('Temporary outage');
    if (calls.length === 2) first.stop();
    return [];
  } });
  await first.run();
  const original = first.status();
  assert.equal(original.progress.checked, 2);
  assert.equal(original.last.finished_at, null);
  const resumed = createRefresher(store, { collector: async source => { calls.push(source.id); return []; } });
  t.after(() => resumed.stop());
  assert.equal(resumed.status().progress.checked, 2);
  await resumed.run();
  assert.equal(resumed.status().last.id, original.last.id);
  assert.equal(calls.length, 8); assert.equal(new Set(calls).size, 8);
  assert.equal(resumed.status().last.errors.length, 1);
  assert.match(resumed.status().last.errors[0], /Temporary outage/);
  assert.ok(resumed.status().last.finished_at);
  calls.length = 0;
  await resumed.run();
  assert.equal(calls.length, 8); assert.equal(new Set(calls).size, 8);
  assert.notEqual(resumed.status().last.id, original.last.id);
  assert.equal(store.setting('refresh_checkpoint'), 'null');
});

test('Greenhouse discovery takes one request and background detail fetching retains the publication date and history', async t => {
  const store = setup(t), source = store.sources().find(s => s.kind === 'greenhouse');
  let calls = 0;
  const jobs = await collectSource({ ...source, searchOptions: { details: 0 } }, async () => {
    calls++;
    return { jobs: Array.from({ length: 150 }, (_, i) => ({ id: i + 1, title: `Software Intern ${i}`, location: { name: 'Remote' }, absolute_url: `https://job-boards.greenhouse.io/${source.token}/jobs/${i+1}` })) };
  });
  assert.equal(calls, 1); assert.equal(jobs.length, 150);
  store.ingest(source, jobs);
  const job = store.jobs()[0], firstSeen = job.firstSeen;
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(job.id, 'applied', '2026-10-27', 'Keep my note');
  const detail = await fetchJobDescription(job, [], { request: async () => ({ body: JSON.stringify({ content: full, first_published: '2026-10-20', updated_at: '2026-10-27' }) }) });
  store.updateDescription(job.id, detail);
  const result = store.job(job.id);
  assert.equal(result.postedAt, '2026-10-20T00:00:00.000Z');
  assert.equal(result.dateBasis, 'published'); assert.equal(result.description, full);
  assert.equal(result.status, 'applied'); assert.equal(result.note, 'Keep my note');
  assert.equal(result.firstSeen, firstSeen); assert.equal(result.remote, true);
});

test('detail workers spread across hosts, keep per-host pacing and drain the backlog', async t => {
  const store = setup(t), source = store.sources()[0];
  store.db.prepare('UPDATE sources SET enabled=1 WHERE id=?').run(source.id);
  const jobs = Array.from({ length: 16 }, (_, i) => ({ title: `Intern ${i}`, company: `Company ${i}`, location: 'Boston', url: `https://${i < 10 ? 'busy' : 'host' + i}.example.com/${i}`, description: '', terms: [], years: [] }));
  store.ingest(source, jobs);
  let active = 0, peak = 0;
  const times = new Map();
  const worker = createEnricher(store, { batchSize: 6, hostDelayMs: 15, resolver: async (job, refs, { beforeRequest }) => {
    const host = new URL(job.url).hostname;
    await beforeRequest(host);
    if (!times.has(host)) times.set(host, []);
    times.get(host).push(Date.now());
    peak = Math.max(peak, ++active);
    await pause(10); active--;
    return { description: full, url: job.url };
  } });
  t.after(async () => { worker.stop(); await worker.drain(); });
  worker.sync();
  store.db.prepare("UPDATE enrichment_queue SET priority=1000 WHERE job_id IN (SELECT id FROM jobs WHERE url LIKE 'https://busy.%')").run();
  await worker.run();
  assert.equal(peak, 6, 'One busy host must not monopolize the worker slots');
  assert.equal(worker.status().counts.done, 6);
  await worker.run(); await worker.run();
  assert.equal(worker.status().counts.done, 16);
  for (const requests of times.values()) for (let i = 1; i < requests.length; i++) assert.ok(requests[i] - requests[i-1] >= 12);
});
