import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';
import { createMatchCache, scoreJob } from '../server/matching.js';

test('status changes and state polling never scan or re-score the catalog', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-fast-status-')), store = openStore(directory);
  store.ingest(store.sources()[0], [{ title: 'Python Intern', company: 'Test', location: 'California', url: 'https://example.com/job', description: '' }]);
  const job = store.jobs()[0];
  const { app, enricher, refresher } = createApp({ store });
  enricher.sync();
  store.jobs = () => { throw new Error('A single status change must not scan every posting.'); };
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => { enricher.stop(); refresher.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const status of ['hidden', 'applied', 'new', 'saved']) {
    const response = await fetch(`${base}/jobs/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    assert.equal(response.status, 200);
    assert.equal(store.job(job.id).status, status);
    assert.equal(enricher.jobStatus(job.id).state, ['hidden','applied'].includes(status) ? 'paused' : 'pending');
    const state = await (await fetch(`${base}/state`)).json();
    assert.equal(state.counts.applied, Number(status === 'applied'));
    assert.equal(state.counts.saved, Number(status === 'saved'));
    assert.equal(state.counts.active, Number(['new','saved'].includes(status)));
  }
});

test('cached matches survive status updates and invalidate for changed profile or posting text', () => {
  const match = createMatchCache({ limit: 2 });
  const profile = { resume: 'Python React SQL projects.', roles: '', keywords: '' };
  const job = { id: 'a', title: 'Software Intern', description: 'Python SQL', descriptionQuality: 'summary' };
  const initial = match(job, profile);
  assert.equal(match({ ...job, status: 'applied' }, { ...profile }), initial);
  for (const changed of [{ ...profile, resume: 'Robotics CAD MATLAB' }, { ...profile, roles: 'Accounting' }, { ...profile, keywords: 'Python' }]) {
    assert.deepEqual(match(job, changed), scoreJob(job, changed));
    assert.notEqual(match(job, changed), initial);
  }
  const full = { ...job, description: 'Python React SQL software. '.repeat(20), descriptionQuality: 'full' };
  assert.deepEqual(match(full, profile), scoreJob(full, profile));
  assert.equal(match(full, profile).provisional, false);
  assert.deepEqual(match({ ...full, title: 'SQL Intern' }, profile), scoreJob({ ...full, title: 'SQL Intern' }, profile));
});

test('SQL counters and coverage match catalog semantics for disabled and historical memberships', t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-counts-')), store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const [community, employer] = store.sources(), job = { title: 'Intern', company: 'Test', location: 'CA', url: 'https://example.com/job', description: '' };
  store.ingest(community, [job]); store.ingest(employer, [job]);
  store.ingest(employer, []);
  let stats = store.statistics();
  assert.equal(stats.counts.active, 1);
  assert.equal(stats.platformCounts.greenhouse, 1, 'Historical platform membership remains visible while another source is active.');
  store.db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run(community.id);
  assert.equal(store.statistics().counts.active, 0);
  assert.deepEqual(store.statistics().platformCounts, {});
});
