import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jobSpyInput, runJobSpy } from '../server/jobspy.js';
import { parseJobSpyRows, collectWebSource, SourceAccessError } from '../server/web-sources.js';
import { openStore } from '../server/db.js';
import { createRefresher } from '../server/refresh.js';

const row = (extra = {}) => ({ title: 'Software Intern Summer 2027', company: 'Example', location: 'California', job_url: 'https://www.indeed.com/rc/clk?jk=abcdef&utm_source=test', description: 'Python and SQL. '.repeat(30), date_posted: '2026-10-20T00:00:00', job_type: ['internship'], is_remote: false, ...extra });
function worker(events, { code = 0, hang = false, onSpawn = () => {} } = {}) {
  return (python, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit('close', 1));
    child.stdin.end = input => {
      onSpawn({ python, args, options, input: JSON.parse(input) });
      queueMicrotask(() => { for (const event of events) child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n')); if (!hang) child.emit('close', code); });
    };
    return child;
  };
}

test('JobSpy input only contains explicit search parameters and bounded limits', () => {
  const input = jobSpyInput('indeed', [{ keywords: 'software internship', location: 'California', resume: 'PRIVATE RESUME', apiKey: 'SECRET' }], { resultsWanted: 9999, remoteOnly: true, resume: 'PRIVATE' });
  assert.deepEqual(input, { kind: 'indeed', queries: [{ keywords: 'software internship', location: 'California' }], resultsWanted: 200, country: 'USA', remoteOnly: true });
  assert.doesNotMatch(JSON.stringify(input), /PRIVATE|SECRET/);
  assert.throws(() => jobSpyInput('linkedin', []), /Unsupported/);
});

test('JobSpy records use stable platform URLs, source dates and genuine descriptions', () => {
  const rows = parseJobSpyRows('indeed', [row(), row(), row({ job_url: 'https://evil.example/viewjob?jk=nope' }), row({ title: 'Senior Developer', job_type: ['fulltime'] }), row({ job_url: 'javascript://www.indeed.com/job?jk=bad' })]);
  assert.equal(rows.length, 1); assert.equal(rows[0].url, 'https://www.indeed.com/viewjob?jk=abcdef');
  assert.equal(rows[0].dateBasis, 'listing'); assert.equal(rows[0].postedAt, '2026-10-20T00:00:00.000Z');
  assert.equal(rows[0].descriptionQuality, 'full');
  assert.equal(parseJobSpyRows('ziprecruiter', [row({ job_url: 'https://www.ziprecruiter.com/c/Example/Job/Intern?jid=123' })]).length, 1);
});

test('Python worker runs without a shell and parses incremental JSON results', async () => {
  const input = jobSpyInput('indeed', [{ keywords: 'internship', location: '' }]); let invocation;
  const result = await runJobSpy(input, { python: 'test-python', spawnProcess: worker([{ type: 'query', rows: [row()], warnings: [] }, { type: 'complete' }], { onSpawn: value => { invocation = value; } }) });
  assert.equal(result.rows.length, 1); assert.equal(result.partial, false);
  assert.equal(invocation.options.shell, false); assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.input, input);
  assert.equal(invocation.options.env.SERPAPI_API_KEY, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
});

test('blocked and failed workers cannot masquerade as successful empty searches', async () => {
  const input = jobSpyInput('ziprecruiter', [{ keywords: 'internship', location: '' }]);
  await assert.rejects(() => runJobSpy(input, { spawnProcess: worker([{ type: 'query', rows: [], error: 'HTTP 403' }, { type: 'complete' }]) }), /403/);
  await assert.rejects(() => runJobSpy(input, { spawnProcess: worker([], { code: 2 }) }), /stopped/);
  await assert.rejects(() => runJobSpy(input, { spawnProcess: worker([null]) }), /invalid response/);
  const empty = await runJobSpy(input, { spawnProcess: worker([{ type: 'query', rows: [], warnings: [] }, { type: 'complete' }]) });
  assert.deepEqual(empty.rows, []); assert.equal(empty.partial, false);
});

test('completed JobSpy queries survive later failures and response-size limits', async () => {
  const input = jobSpyInput('indeed', [{ keywords: 'internship', location: '' }]);
  const result = await runJobSpy(input, { spawnProcess: worker([{ type: 'query', rows: [row()] }, { type: 'query', rows: [], error: 'HTTP 429' }, { type: 'complete' }]) });
  assert.equal(result.rows.length, 1); assert.equal(result.partial, true); assert.match(result.warnings.join(' '), /429/);
  const limited = await runJobSpy(input, { maxBytes: 2000, spawnProcess: worker([{ type: 'query', rows: [row()] }, { type: 'query', rows: [row({ description: 'x'.repeat(10000) })] }]) });
  assert.equal(limited.rows.length, 1); assert.equal(limited.partial, true); assert.match(limited.warnings.join(' '), /size limit/);
});

test('a timed-out worker is terminated and keeps already completed queries', async () => {
  const result = await runJobSpy(jobSpyInput('indeed', [{ keywords: 'internship' }]), { timeoutMs: 1000, spawnProcess: worker([{ type: 'query', rows: [row()] }], { hang: true }) });
  assert.equal(result.rows.length, 1); assert.equal(result.partial, true); assert.match(result.warnings.join(' '), /timed out/);
});

test('JobSpy is preferred for supported sites while public and indexed fallbacks remain available', async () => {
  let publicCalls = 0;
  const direct = await collectWebSource({ kind: 'indeed' }, { profile: { resume: 'PRIVATE RESUME', roles: 'software' }, jobspy: true, jobspyFetcher: async input => {
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE/); return { rows: [row()], warnings: [] };
  }, htmlFetcher: async () => { publicCalls++; throw new Error('Must not be used.'); } });
  assert.equal(direct.mode, 'jobspy'); assert.equal(direct.jobs.length, 1); assert.equal(publicCalls, 0);
  const indexed = await collectWebSource({ kind: 'indeed' }, { jobspy: true, jobspyFetcher: async () => { throw new Error('HTTP 403'); }, htmlFetcher: async () => { throw new SourceAccessError('Public HTTP 403'); }, apiKey: 'test-only', jsonFetcher: async () => ({ jobs_results: [{ title: 'Data Intern', company_name: 'Example', apply_options: [{ link: 'https://www.indeed.com/viewjob?jk=123' }] }] }) });
  assert.equal(indexed.mode, 'indexed'); assert.equal(indexed.jobs.length, 1); assert.match(indexed.warnings.join(' '), /JobSpy/);
  await assert.rejects(() => collectWebSource({ kind: 'ziprecruiter' }, { jobspy: true, apiKey: '', jobspyFetcher: async () => { throw new Error('JobSpy HTTP 403'); }, htmlFetcher: async () => { throw new SourceAccessError('Public HTTP 403'); } }), /JobSpy.*403.*Public fallback/);
});

test('every refresh invokes JobSpy again and retains Applied status and notes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-jobspy-')), store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.db.prepare("UPDATE sources SET enabled=CASE WHEN kind='indeed' THEN 1 ELSE 0 END").run();
  let calls = 0;
  const refresher = createRefresher(store, { collector: source => collectWebSource(source, { jobspy: true, jobspyFetcher: async () => { calls++; return { rows: [row()], warnings: [] }; } }) });
  await refresher.run(); const job = store.jobs()[0];
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(job.id, 'applied', '2026-10-23', 'Existing notes');
  await refresher.run(); refresher.stop();
  assert.equal(calls, 2); assert.equal(store.jobs().length, 1);
  assert.equal(store.job(job.id).status, 'applied'); assert.equal(store.job(job.id).note, 'Existing notes');
  assert.equal(store.sources().find(source => source.kind === 'indeed').last_mode, 'jobspy');
});
