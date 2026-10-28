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

test('health, discovery and text uploads work even if PDF native dependencies cannot load', () => {
  const script = `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(name, context, next) {
      if (/pdf-parse|pdfjs-dist|@napi-rs/.test(name)) throw new Error('Simulated missing serverless PDF dependency');
      return next(name, context);
    } });
    const { createStatelessApp } = await import('./server/stateless.js');
    const app = createStatelessApp({ collector: async () => {
      const rows = []; rows.discoveredBoards = [{kind:'ashby',token:'new-board',name:'New board'}]; return rows;
    } });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal((await fetch(base+'/api/health')).status,200);
      const scan = await fetch(base+'/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:{kind:'community',name:'Community',token:'Summer2027-Internships'}})});
      assert.equal((await scan.json()).discoveredBoards[0].token,'new-board');
      const form = new FormData(); form.append('resume',new Blob(['Software engineering student with Python and SQL experience.']),'resume.txt');
      const uploaded = await fetch(base+'/api/resume',{method:'POST',body:form});
      assert.equal(uploaded.status,200);
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, VERCEL: '1' } });
});

async function serve(t, options) {
  const server = createStatelessApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('detail API preserves employer rate limits for the browser queue', async t => {
  const retryAfter = Date.now() + 7200000;
  const base = await serve(t, { detail: async () => { throw Object.assign(new Error('Employer rate limit'), { status: 429, retryAfter }); } });
  const response = await post(base, '/detail', { job: { url: 'https://fixture.wd1.myworkdayjobs.com/Careers/job/Intern_JR123', title: 'Intern' } });
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.status, 429); assert.equal(result.retryAfter, retryAfter); assert.equal(result.permanent, false);
});
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
