// Controlled network-latency benchmark using an isolated fixture database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openStore } from '../server/db.js';
import { createRefresher } from '../server/refresh.js';

const directory = mkdtempSync(join(tmpdir(), 'internscope-scrape-benchmark-'));
const store = openStore(directory);
store.db.prepare('UPDATE sources SET enabled=0').run();
for (let i = 0; i < 96; i++) store.db.prepare("INSERT INTO sources(kind,token,name) VALUES ('workday',?,?)").run(`speed${i}.wd1.myworkdayjobs.com/Careers`, `Fixture ${i}`);
async function measure(concurrency) {
  let calls = 0;
  const service = createRefresher(store, { concurrency, backgroundDetails: true, collector: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 60)); return [];
  } });
  const start = performance.now();
  try {
    await service.run();
    assert.equal(calls, 96);
    assert.deepEqual(service.status().last.errors, []);
    return Math.round(performance.now() - start);
  } finally { service.stop(); }
}
try {
  const threeWorkersMs = await measure(3), sixteenWorkersMs = await measure(16);
  console.log(JSON.stringify({ fixtureBoards: 96, simulatedLatencyMs: 60, threeWorkersMs, sixteenWorkersMs, speedup: Number((threeWorkersMs / sixteenWorkersMs).toFixed(2)), note: 'Controlled scheduler benchmark; real website latency and rate limits vary.' }));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
