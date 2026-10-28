import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, DEFAULT_PROFILE } from '../server/db.js';
import { createApp } from '../server/index.js';
import { createRefresher } from '../server/refresh.js';
import { parseGreenhouse, parseLever, parseAshby, parseCommunity, collectSource } from '../server/providers.js';
import { resumeText, canonicalUrl } from '../server/text.js';
import { scoreJob, fits, priority, extractSkills } from '../server/matching.js';
import { parseResume } from '../server/resume.js';
import { zipSync, strToU8 } from 'fflate';

function fixtureStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'internscope-test-'));
  const store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const internship = (overrides = {}) => ({ title: 'Software Engineering Intern — Summer 2027', company: 'Acme', url: 'https://jobs.example.com/123', location: 'Los Angeles, California', description: 'Build software with Python, React, SQL, and Git. Work with data pipelines and AWS.', terms: ['summer'], years: ['2027'], postedAt: '2026-10-20T12:00:00.000Z', dateBasis: 'published', remote: false, ...overrides });

test('provider adapters use published dates and never mislabel Greenhouse edits', () => {
  const gh = parseGreenhouse({ jobs: [{ title: 'Software Intern', absolute_url: 'https://example.com/job', updated_at: '2026-10-20', content: '&lt;p&gt;Python &amp;amp; SQL&lt;/p&gt;', location: { name: 'Remote' } }, { title: 'Senior Engineer' }] }, { name: 'Acme' });
  assert.equal(gh.length, 1); assert.equal(gh[0].postedAt, null); assert.equal(gh[0].dateBasis, 'unknown');
  assert.equal(gh[0].description, 'Python & SQL'); assert.equal(gh[0].remote, true);
  const ashby = parseAshby({ jobs: [{ title: 'Design role', employmentType: 'Intern', isListed: true, publishedAt: '2026-01-01', jobUrl: 'https://example.com/a' }, { title: 'Hidden Intern', isListed: false }] }, { name: 'Acme' });
  assert.equal(ashby.length, 1); assert.match(ashby[0].postedAt, /2026-01-01/);
  const lever = parseLever([{ text: 'Engineering Co-op', categories: { commitment: 'Internship', location: 'NYC' }, hostedUrl: 'https://example.com/l', createdAt: 1700000000000 }], { name: 'Acme' });
  assert.equal(lever.length, 1); assert.equal(lever[0].postedAt, '2023-11-14T22:13:20.000Z');
});
test('community term metadata retains season and year, and closed jobs are omitted', () => {
  const rows = parseCommunity([{ title: 'Developer Intern', company_name: 'Acme', url: 'https://example.com/a', terms: ['Summer 2027'], locations: ['Boston'], active: true }, { title: 'Closed', url: 'https://example.com/b', active: false }]);
  assert.deepEqual(rows[0].terms, ['summer']); assert.deepEqual(rows[0].years, ['2027']); assert.equal(rows.length, 1);
  assert.equal(fits(rows[0], { ...DEFAULT_PROFILE, season: 'summer', year: '2027', includeUnknown: false }), true);
});
test('large Greenhouse boards fetch descriptions only for internships', async () => {
  const requests = [];
  const rows = await collectSource({ kind: 'greenhouse', token: 'acme', name: 'Acme' }, async url => {
    requests.push(url);
    if (url.endsWith('/jobs')) return { jobs: [{ id: 1, title: 'Python Intern', absolute_url: 'https://example.com/1' }, { id: 2, title: 'Senior Engineer' }] };
    return { id: 1, title: 'Python Intern', content: '<p>Python and React.</p>', first_published: '2026-01-01', absolute_url: 'https://example.com/1' };
  });
  assert.equal(requests.length, 2); assert.ok(!requests[0].includes('content=true'));
  assert.equal(rows[0].description, 'Python and React.'); assert.equal(rows[0].dateBasis, 'published');
});
test('matching recognizes bounded skill names, reports evidence, and respects filters', () => {
  assert.deepEqual(extractSkills('JavaScript and React, Python and C++'), ['Python', 'JavaScript', 'C++', 'React']);
  const profile = { ...DEFAULT_PROFILE, resume: 'Software developer with Python React SQL Git AWS and data pipelines', roles: 'software', locations: 'California', season: 'summer', year: '2027' };
  const good = scoreJob(internship(), profile), bad = scoreJob(internship({ description: 'Build PCBs with Altium, MATLAB, Verilog and SolidWorks.', title: 'Hardware Intern' }), profile);
  assert.ok(good.score > bad.score); assert.ok(good.matched.includes('Python')); assert.equal(good.score <= 99, true);
  assert.equal(fits(internship(), profile), true);
  assert.equal(fits(internship({ location: 'London' }), profile), false);
  assert.equal(fits(internship({ location: 'London', remote: true }), profile), true);
  assert.equal(fits(internship({ terms: [], years: [] }), { ...profile, includeUnknown: false }), false);
  assert.equal(scoreJob(internship(), DEFAULT_PROFILE).score, null);
  assert.ok(priority({ postedAt: '2026-10-21' }, 80, Date.parse('2026-10-21')) > priority({ postedAt: '2026-09-01' }, 80, Date.parse('2026-10-21')));
});
test('resume source is read as text and plain-text percentages survive', () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\section{Experience}
\textbf{Robotics Intern} Developed Python firmware and C++ systems.
\end{document}`;
  const text = resumeText(latex);
  assert.match(text, /Experience/); assert.match(text, /Robotics Intern/); assert.doesNotMatch(text, /documentclass/);
  assert.match(resumeText('Improved throughput 35% using Python and SQL.'), /35% using Python and SQL/);
  assert.equal(resumeText('<script>alert(1)</script><p>Python developer</p>'), 'Python developer');
});
test('canonical deduplication survives refreshes and keeps applications', t => {
  const store = fixtureStore(t), sources = store.sources();
  store.ingest(sources[0], [internship({ url: 'https://jobs.example.com/123?utm_source=feed', dateBasis: 'listing' })]);
  const id = store.jobs()[0].id;
  store.db.prepare('INSERT INTO applications VALUES (?,?,?,?)').run(id, 'applied', '2026-10-21', 'Interview contact');
  store.ingest(sources[1], [internship({ postedAt: '2026-10-18T12:00:00.000Z', description: 'A longer posting about Python and React plus SQL and Git with detailed engineering responsibilities.' })]);
  assert.equal(store.jobs().length, 1); assert.equal(store.jobs()[0].status, 'applied');
  assert.equal(store.jobs()[0].dateBasis, 'published'); assert.equal(store.jobs()[0].postedAt, '2026-10-18T12:00:00.000Z');
  store.ingest(sources[0], []); assert.equal(store.jobs()[0].active, true);
  store.ingest(sources[1], []); assert.equal(store.jobs()[0].active, false); assert.equal(store.jobs()[0].note, 'Interview contact');
  assert.equal(canonicalUrl('https://example.com/a?utm_source=x&job=3#apply'), 'https://example.com/a?job=3');
});
test('source failures retain results while successful empty feeds close them', async t => {
  const store = fixtureStore(t), source = store.sources()[0];
  store.db.prepare('UPDATE sources SET enabled=0 WHERE id!=?').run(source.id);
  store.ingest(source, [internship()]);
  const refresher = createRefresher(store, { collector: async () => { throw new Error('Temporary outage'); }, enrich: async jobs => jobs });
  t.after(() => refresher.stop());
  await refresher.run();
  assert.equal(store.jobs()[0].active, true); assert.match(store.sources()[0].last_error, /Temporary outage/);
  assert.equal(refresher.status().running, false); assert.equal(refresher.status().last.errors.length, 1);
});
test('scheduler refreshes again automatically without a browser request', async t => {
  const store = fixtureStore(t);
  let calls = 0;
  store.db.prepare('UPDATE sources SET enabled=0 WHERE id!=1').run();
  // Simulate a due refresh and verify start schedules background work.
  store.db.prepare('INSERT INTO refresh_runs(started_at,finished_at) VALUES (?,?)').run('2000-01-01', '2000-01-01');
  const refresher = createRefresher(store, { hours: 2, collector: async () => { calls++; return []; }, enrich: async jobs => jobs });
  t.after(() => refresher.stop()); refresher.start();
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(calls, 1); assert.ok(refresher.status().last.finished_at);
});
test('HTTP workflow: profile, upload, matching, applied removal, persistence, notes and restore', async t => {
  const store = fixtureStore(t);
  store.ingest(store.sources()[0], [internship()]);
  const { app, refresher } = createApp({ store, collector: async () => [], enrich: async jobs => jobs });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { refresher.stop(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/profile', 'PUT', { resume: 'Experienced developer using Python, React, SQL, Git, AWS and data pipelines.', locations: 'California' })).status, 200);
  let results = (await call('/jobs')).body;
  assert.equal(results.total, 1); assert.ok(results.jobs[0].match.score > 60);
  const id = results.jobs[0].id;
  assert.equal((await call(`/jobs/${id}`, 'PATCH', { status: 'applied', note: 'Applied on company site' })).status, 200);
  assert.equal((await call('/jobs')).body.total, 0);
  assert.equal((await call('/jobs?view=applied')).body.total, 1);
  store.ingest(store.sources()[0], [internship()]);
  assert.equal((await call('/jobs')).body.total, 0);
  assert.equal((await call(`/jobs/${id}`, 'PATCH', { note: 'Follow up next week' })).status, 200);
  assert.equal((await call('/jobs?view=applied')).body.jobs[0].note, 'Follow up next week');
  await call(`/jobs/${id}`, 'PATCH', { status: 'new' });
  assert.equal((await call('/jobs')).body.total, 1);
  const file = new FormData(); file.append('resume', new Blob(['Software engineering student with Python and React experience. SQL projects and Git.']), 'resume.txt');
  const upload = await fetch(origin + '/api/resume', { method: 'POST', body: file });
  assert.equal(upload.status, 200); assert.equal((await upload.json()).profile.resumeName, 'resume.txt');
  const forged = await fetch(origin + '/api/profile', { method: 'PUT', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forged.status, 403);
  assert.equal((await call('/sources', 'POST', { kind: 'greenhouse', name: 'Bad', token: '../localhost' })).status, 400);
  assert.equal((await call('/profile', 'PUT', { remoteOnly: 'true' })).status, 400);
  assert.equal((await call('/cron/refresh', 'POST')).status, 401);
});
test('real PDF parsing extracts resume text and malformed uploads fail clearly', async () => {
  const text = 'Software engineering student with Python React SQL and Git experience.';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const parsed = await parseResume({ originalname: 'resume.pdf', buffer: Buffer.from(pdf) });
  assert.match(parsed, /Python React SQL/);
  await assert.rejects(() => parseResume({ originalname: 'resume.pdf', buffer: Buffer.from('not a PDF') }), /valid PDF/);
});
test('DOCX parsing extracts paragraphs, tables and escaped text without executing content', async () => {
  const document = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Engineering student with Python &amp; SQL experience.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Built React applications and embedded systems.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const buffer = Buffer.from(zipSync({ 'word/document.xml': strToU8(document), '[Content_Types].xml': strToU8('<Types/>') }));
  const parsed = await parseResume({ originalname: 'resume.docx', buffer });
  assert.match(parsed, /Python & SQL/); assert.match(parsed, /\nBuilt React/);
  await assert.rejects(() => parseResume({ originalname: 'bad.docx', buffer: Buffer.from('bad file') }), /valid DOCX/);
});
