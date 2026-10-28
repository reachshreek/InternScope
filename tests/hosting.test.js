import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatelessApp } from '../server/stateless.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('Vercel entry starts in a fresh instance without SQLite or backend configuration', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', "const api = await import('./api/index.js'); console.log(typeof api.default);"], { env: { ...process.env, VERCEL: '1', BACKEND_URL: '' }, encoding: 'utf8' });
  assert.match(result, /function/);
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(config.functions['api/index.js'].maxDuration, 60);
});

async function serve(t, options) {
  const server = createStatelessApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('stateless scan waits for results, validates targets, strips resumes, and disables Python', async t => {
  let calls = 0;
  const base = await serve(t, { collector: async source => {
    calls++;
    assert.equal(source.searchOptions.jobspy, false);
    assert.equal(source.searchOptions.pages, 2);
    assert.equal(source.searchOptions.profile.resume, undefined);
    assert.equal(source.searchOptions.profile.roles, 'Software');
    await new Promise(resolve => setTimeout(resolve, 15));
    return [{ title: 'Software Intern', company: 'Fixture', url: 'https://jobs.ashbyhq.com/fixture/id', description: '' }];
  } });
  assert.equal((await post(base, '/scan', { source: { kind: 'workday', name: 'Bad', token: 'localhost/Careers' } })).status, 400);
  assert.equal(calls, 0);
  const result = await post(base, '/scan', { source: { kind: 'ashby', name: 'Fixture', token: 'fixture' }, profile: { roles: 'Software', resume: 'PRIVATE' } });
  assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.jobs.length, 1); assert.equal(data.discoveredBoards[0].token, 'fixture');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/state')).status, 404);
});
test('uploaded resume is parsed per request and never becomes shared state', async t => {
  const first = await serve(t), second = await serve(t);
  const form = new FormData(); form.append('resume', new Blob(['Python developer with React, SQL and software engineering projects.']), 'resume.txt');
  const data = await (await fetch(first + '/api/resume', { method: 'POST', body: form })).json();
  assert.equal(data.resume, 'Python developer with React, SQL and software engineering projects.');
  assert.equal((await fetch(second + '/api/state')).status, 404);
  assert.equal((await post(first, '/detail', { job: { title: 'Intern', url: 'http://127.0.0.1/private' } })).status, 400);
});
test('large source responses are bounded and explicitly partial', async t => {
  const base = await serve(t, { collector: async () => Array.from({ length: 500 }, (_,i) => ({ title: 'Intern', company: 'Fixture', url: `https://example.com/${i}`, description: 'x'.repeat(15000) })) });
  const result = await (await post(base, '/scan', { source: { kind: 'ashby', token: 'fixture', name: 'Fixture' } })).json();
  assert.equal(result.complete, false); assert.ok(result.jobs.length < 500); assert.equal(result.jobs[0].descriptionQuality, 'summary');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4_000_000);
});
