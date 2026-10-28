// Compare old/new source lookup on a disposable catalog, never the user's database.
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE job_sources(job_id TEXT,source_id INTEGER,active INTEGER,PRIMARY KEY(job_id,source_id))');
const insert = db.prepare('INSERT INTO job_sources VALUES (?,?,1)');
db.exec('BEGIN');
for (let board = 1; board <= 2800; board++) for (let job = 0; job < 20; job++) insert.run(`${board}-${job}`, board);
db.exec('COMMIT');
function measure() {
  const count = db.prepare('SELECT count(*) count FROM job_sources WHERE source_id=? AND active=1');
  const start = performance.now();
  for (let board = 1; board <= 2800; board++) assert.equal(count.get(board).count, 20);
  return Math.round(performance.now() - start);
}
try {
  const beforeMs = measure();
  db.exec('CREATE INDEX job_sources_source_active ON job_sources(source_id,active,job_id)');
  const afterMs = measure();
  console.log(JSON.stringify({ boards: 2800, memberships: 56000, beforeMs, afterMs, note: 'Isolated database lookup benchmark, not end-to-end scrape timing.' }));
} finally { db.close(); }
