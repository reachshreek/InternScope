import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWebSource } from '../server/web-sources.js';

const indexed = { jobs_results: [
  { title: 'Software Internship', company_name: 'Fixture', location: 'Seattle', description: 'Build software with Python. '.repeat(15), apply_options: [{ link: 'https://www.indeed.com/viewjob?jk=abc123' }, { link: 'https://www.ziprecruiter.com/c/Fixture/Job/Software-Intern/-in-Seattle,WA?jid=123' }] },
  { title: 'Other Internship', company_name: 'Wrong platform', apply_options: [{ link: 'https://example.com/job' }, { link: 'https://indeed.com.evil.example/job?jk=abc' }] }
] };
for (const kind of ['indeed', 'ziprecruiter']) test(`${kind} indexed mode skips direct pages and imports only platform links`, async () => {
  const requests = [];
  const result = await collectWebSource({ kind }, {
    jobspy: false, apiKey: 'test-secret', preferIndexed: true, queryLimit: 2,
    profile: { roles: 'Software', locations: 'Seattle, Boston', remoteOnly: true, resume: 'PRIVATE_RESUME' },
    htmlFetcher: () => { assert.fail('Indexed mode should skip blocked direct pages'); },
    jsonFetcher: async value => { requests.push(new URL(value)); return indexed; }
  });
  assert.equal(requests.length, 2);
  for (const url of requests) {
    assert.match(url.searchParams.get('q'), /Software internship remote/);
    assert.equal(url.searchParams.get('no_cache'), 'false');
    assert.equal(url.searchParams.get('api_key'), 'test-secret');
    assert.ok(!url.toString().includes('PRIVATE_RESUME'));
  }
  assert.equal(result.jobs.length, 1); assert.equal(result.mode, 'indexed'); assert.equal(result.complete, false);
  assert.equal(new URL(result.jobs[0].url).hostname, `www.${kind}.com`);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});
test('indexed failure preserves earlier results and redacts provider errors', async () => {
  let calls = 0;
  const result = await collectWebSource({ kind: 'indeed' }, { jobspy: false, apiKey: 'secret', preferIndexed: true, profile: { locations: 'Seattle,Boston' }, jsonFetcher: async () => { if (calls++) throw new Error('URL containing secret'); return indexed; } });
  assert.equal(result.jobs.length, 1); assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /partial results/);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('without a key public search is still attempted and blocked access stays visible', async () => {
  await assert.rejects(collectWebSource({ kind: 'indeed' }, { jobspy: false, apiKey: '', preferIndexed: true, htmlFetcher: async () => { throw new Error('Public search blocked'); }, jsonFetcher: () => { assert.fail('No key'); } }), /Public search blocked/);
});
