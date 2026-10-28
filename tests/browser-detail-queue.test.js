import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDetailQueue } from '../public/detail-queue.js';

const job = (id, host = 'fixture.wd1.myworkdayjobs.com') => ({ id, url: `https://${host}/Careers/job/${id}` });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Queue did not reach expected state');
}
test('background and opened postings share limits, host pacing, priority and in-flight work', async t => {
  const starts = [], releases = new Map();
  const queue = createDetailQueue({ concurrency: 2, spacing: 30, eligible: () => true,
    fetchDetail: id => { starts.push({ id, at: Date.now() }); return new Promise(resolve => releases.set(id, resolve)); }, applyDetail() {} });
  t.after(() => queue.dispose());
  queue.add(job('a')); queue.add(job('b')); queue.add(job('c', 'second.wd1.myworkdayjobs.com'));
  queue.add(job('b'), { manual: true, priority: 100 });
  await until(() => starts.length === 2);
  assert.deepEqual(starts.map(s => s.id), ['b', 'c']);
  queue.add(job('b'), { manual: true, priority: 100 });
  const releasedAt = Date.now(); releases.get('b')({});
  await until(() => starts.length === 3);
  assert.equal(starts[2].id, 'a'); assert.ok(starts[2].at - releasedAt >= 25);
  releases.get('a')({}); releases.get('c')({});
  await until(() => !queue.state().running);
  assert.equal(queue.state().counts.done, 3);
});
test('rate limits cool down the host and opening a posting cannot bypass them', async t => {
  let calls = 0;
  const queue = createDetailQueue({ eligible: () => true, spacing: 0,
    fetchDetail: async () => { calls++; throw Object.assign(new Error('Rate limited'), { status: 429 }); }, applyDetail() {} });
  t.after(() => queue.dispose());
  queue.add(job('a')); queue.add(job('b'));
  await until(() => queue.state().cooldowns.length === 1);
  queue.add(job('a'), { manual: true, priority: 100 });
  await delay(30);
  assert.equal(calls, 1); assert.equal(queue.state().counts.pending, 2);
  assert.ok(queue.get('a').readyAt > Date.now() + 3500000);
});
test('transient failures retry at most three times and permanent failures retain their message', async t => {
  let calls = 0;
  const queue = createDetailQueue({ eligible: () => true, spacing: 0, retryDelay: 5,
    fetchDetail: async id => { calls++; throw Object.assign(new Error(id), { permanent: id === 'gone' }); }, applyDetail() {} });
  t.after(() => queue.dispose());
  queue.add(job('temporary')); queue.add(job('gone', 'second.wd1.myworkdayjobs.com'));
  await until(() => queue.state().counts.unavailable === 2);
  assert.equal(calls, 4); assert.equal(queue.get('gone').lastError, 'gone');
  assert.equal(queue.state().running, false);
});
test('hidden and applied postings are skipped before work starts', async t => {
  let calls = 0;
  const queue = createDetailQueue({ eligible: () => false, fetchDetail: async () => { calls++; }, applyDetail() {} });
  t.after(() => queue.dispose());
  queue.add(job('hidden')); await delay(20);
  assert.equal(calls, 0); assert.equal(queue.state().running, false);
});
