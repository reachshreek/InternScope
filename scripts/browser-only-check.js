import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStatelessApp } from '../server/stateless.js';
import { resumePdf } from '../tests/fixtures/resume-pdf.js';
import { readFileSync } from 'node:fs';

let calls = 0;
const app = createStatelessApp({ collector: async source => {
  calls++; assert.equal(source.searchOptions.profile.resume, undefined);
  return [{ title: 'Software Intern', company: 'Fixture', url: 'https://jobs.ashbyhq.com/fixture/id', location: 'Seattle', description: 'Build software with Python and React. '.repeat(15), terms: [], years: [] }];
} });
// Use the production CSP, including its worker restrictions.
const csp = JSON.parse(readFileSync('vercel.json', 'utf8')).headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;
app.use((req, res, next) => { res.set('Content-Security-Policy', csp); next(); });
app.use(express.static('dist'));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await expect(page.locator('#resume-state')).toHaveText('GET STARTED');
  await page.evaluate(async () => {
    await api('/profile', { method: 'PUT', body: { resume: 'Python React software developer', roles: 'Software', locations: 'Seattle' } });
    await loadState({ refreshJobs: true });
  });
  await expect(page.locator('#resume-state')).toHaveText('READY TO MATCH');
  await expect(page.locator('.job-card').first()).toBeVisible();
  const id = await page.evaluate(async () => (await api('/jobs')).jobs[0].id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.job-card [data-action="hide"]').first().click();
  await expect(page.locator('.job-card')).toHaveCount(0);
  assert.equal(await page.evaluate(async id => (await api(`/jobs/${id}`)).job.status, id), 'hidden');
  await page.locator('#toast-undo').click();
  await expect(page.locator('.job-card')).toHaveCount(1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'card actions must fit on mobile');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async id => {
    await api(`/jobs/${id}`, { method: 'PATCH', body: { status: 'applied', note: 'Keep my note' } });
    await loadState({ refreshJobs: true });
  }, id);
  await expect(page.locator('#nav-applied')).toHaveText('1');
  await page.reload();
  await expect(page.locator('#resume-state')).toHaveText('READY TO MATCH');
  await expect(page.locator('#preference-summary')).toContainText('Seattle');
  await expect(page.locator('#nav-applied')).toHaveText('1');
  assert.equal(await page.evaluate(async id => (await api(`/jobs/${id}`)).job.note, id), 'Keep my note');
  const upload = await page.evaluate(async () => {
    const form = new FormData(); form.append('resume', new Blob(['Python SQL student with React and software engineering projects.']), 'resume.txt');
    await api('/resume', { method: 'POST', body: form });
    return (await api('/state')).profile;
  });
  assert.equal(upload.roles, 'Software'); assert.equal(upload.resumeName, 'resume.txt');
  let pdfRequests = 0;
  await page.route('**/api/resume', async route => { pdfRequests++; await route.fulfill({ status: 500, body: 'FUNCTION_INVOCATION_FAILED' }); });
  await page.evaluate(() => openModal('resume'));
  await page.locator('#resume-file').setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: resumePdf() });
  await page.locator('#resume-submit').click();
  await expect(page.locator('#modal')).not.toBeVisible();
  const pdfProfile = await page.evaluate(async () => (await api('/state')).profile);
  assert.match(pdfProfile.resume, /Python React SQL/);
  assert.equal(pdfProfile.resumeName, 'resume.pdf');
  assert.equal(pdfProfile.roles, 'Software');
  assert.equal(pdfRequests, 0, 'PDF parsing must not depend on the upload API');
  await page.unroute('**/api/resume');
  const sources = await page.evaluate(async () => (await api('/state')).sources.length); assert.ok(sources > 22);
  await page.reload();
  assert.equal(await page.evaluate(async () => (await api('/state')).sources.length), sources);
  const other = await browser.newContext(), otherPage = await other.newPage(); await otherPage.goto(base);
  await expect(otherPage.locator('#resume-state')).toHaveText('GET STARTED');
  await expect(otherPage.locator('#nav-applied')).toHaveText('0');
  await other.close();
  await page.evaluate(() => openModal('sources'));
  await expect(page.locator('#search-index-form')).toContainText('Indeed and ZipRecruiter search');
  await expect(page.locator('#serpapi-key')).toHaveCount(0);
  await page.locator('#modal').evaluate(dialog => dialog.close());
  const downloadPromise = page.waitForEvent('download');
  await page.locator('a[href="/api/export"]').click();
  assert.equal((await downloadPromise).suggestedFilename(), 'internscope-applications.json');
  // Simulate storage failure: a failed save must leave the previous value intact.
  await page.evaluate(async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    try { await api('/profile', { method: 'PUT', body: { roles: 'SHOULD NOT SAVE' } }); throw new Error('Unexpected success'); }
    catch (error) { if (!error.message.includes('storage')) throw error; }
    finally { Storage.prototype.setItem = original; }
  });
  assert.equal(await page.evaluate(async () => (await api('/state')).profile.roles), 'Software');
  // Exercise automatic Workday details without opening a modal, including a
  // source refresh replacing the record while a detail request is in flight.
  const backfill = await page.evaluate(async () => {
    const { createBrowserWorkspace } = await import('./browser-workspace.js');
    const values = new Map([['internscope.browser.v1.sources', JSON.stringify([{ id: 1, kind: 'workday', name: 'Fixture', token: 'fixture.wd1.myworkdayjobs.com/Careers', enabled: true }])]]);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), key: i => [...values.keys()][i], get length() { return values.size; } };
    let resolveDetail, requests = 0;
    const listing = { title: 'Software Intern', company: 'Fixture', url: 'https://fixture.wd1.myworkdayjobs.com/Careers/job/Seattle/Intern_JR123', location: 'Seattle', description: '', terms: [], years: [], postedAt: '2026-10-20T00:00:00.000Z', dateBasis: 'estimated' };
    const workspace = createBrowserWorkspace({ storage, autoStart: false, request: async (url, options) => {
      if (url.endsWith('/scan')) return Response.json({ jobs: [listing], complete: true });
      if (url.endsWith('/detail')) { requests++; return new Promise(resolve => { resolveDetail = () => resolve(Response.json({ description: 'Python software engineering and React projects. '.repeat(15), descriptionQuality: 'full', url: listing.url, method: 'employer-workday-api', postedAt: '2026-10-18T00:00:00.000Z', dateBasis: 'published', postingMetadata: { workdayDetailsFetchedAt: '2026-10-28T00:00:00.000Z', requisitionId: 'JR123', timeType: 'Full time', locations: ['Seattle', 'Remote'], postedDatePrecision: 'day' } })); }); }
      throw new Error('Unexpected request');
    } });
    try {
      await workspace.scan();
      for (let n = 0; n < 100 && !resolveDetail; n++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!resolveDetail) throw new Error('Automatic backfill did not start');
      const id = [...workspace.jobs.keys()][0];
      await workspace.scan();
      await workspace.api(`/jobs/${id}`, { method: 'PATCH', body: { status: 'saved', note: 'Keep Workday note' } });
      await workspace.api(`/jobs/${id}/enrich`, { method: 'POST' });
      resolveDetail();
      for (let n = 0; n < 100 && (await workspace.api(`/jobs/${id}`)).enrichment.state !== 'done'; n++) await new Promise(resolve => setTimeout(resolve, 10));
      await workspace.scan();
      const result = await workspace.api(`/jobs/${id}`);
      const persisted = JSON.parse(values.get('internscope.browser.v1.application.' + id));
      return { requests, job: result.job, persisted, enrichment: (await workspace.api('/state')).enrichment };
    } finally { workspace.dispose(); }
  });
  assert.equal(backfill.requests, 1, 'automatic and modal work must be deduplicated');
  assert.equal(backfill.job.match.quality, 'full');
  assert.equal(backfill.job.requisitionId, 'JR123');
  assert.equal(backfill.job.dateBasis, 'published');
  assert.equal(backfill.job.postedAt, '2026-10-18T00:00:00.000Z');
  assert.equal(backfill.persisted.note, 'Keep Workday note');
  assert.equal(backfill.persisted.job.descriptionQuality, 'full');
  assert.equal(backfill.enrichment.quality.full, 1);
  assert.equal(errors.length, 0, errors.join('\n')); assert.ok(calls > 22);
  console.log('Vercel-only browser checks passed: automatic Workday details, refresh races, metadata/notes preservation, mobile Hide/Undo, profile/resume/source persistence, isolated users, and quota errors.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
