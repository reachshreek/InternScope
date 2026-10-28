// Benchmarks an isolated snapshot; never changes the user's applications or notes.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';

const directory = mkdtempSync(join(tmpdir(), 'internscope-performance-'));
const source = new DatabaseSync('data/internscope.sqlite', { readOnly: true });
await backup(source, join(directory, 'internscope.sqlite')); source.close();
const store = openStore(directory), { app, enricher, refresher } = createApp({ store });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
async function measure(label, path, options) {
  const start = performance.now(), response = await fetch(base + path, options), data = await response.json();
  assert.equal(response.status, 200);
  console.log(JSON.stringify({ step: label, ms: Math.round(performance.now() - start) }));
  return data;
}
try {
  console.log(JSON.stringify({ catalogJobs: store.db.prepare('SELECT count(*) count FROM jobs').get().count }));
  await measure('state', '/state');
  await measure('feed first load', '/jobs');
  await measure('feed unchanged', '/jobs');
  const job = store.db.prepare('SELECT id FROM jobs LIMIT 1').get();
  for (const status of ['hidden', 'applied', 'new']) {
    await measure(status, `/jobs/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  }
  await measure('feed after status changes', '/jobs');
} finally {
  enricher.stop(); refresher.stop(); await new Promise(resolve => server.close(resolve));
  store.close(); rmSync(directory, { recursive: true, force: true });
}
