import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStatelessApp } from '../server/stateless.js';

let calls = 0;
const app = createStatelessApp({ collector: async source => {
  calls++; assert.equal(source.searchOptions.profile.resume, undefined);
  return [{ title: 'Software Intern', company: 'Fixture', url: 'https://jobs.ashbyhq.com/fixture/id', location: 'Seattle', description: 'Build software with Python and React. '.repeat(15), terms: [], years: [] }];
} });
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
  const sources = await page.evaluate(async () => (await api('/state')).sources.length); assert.ok(sources > 22);
  await page.reload();
  assert.equal(await page.evaluate(async () => (await api('/state')).sources.length), sources);
  const other = await browser.newContext(), otherPage = await other.newPage(); await otherPage.goto(base);
  await expect(otherPage.locator('#resume-state')).toHaveText('GET STARTED');
  await expect(otherPage.locator('#nav-applied')).toHaveText('0');
  await other.close();
  await page.evaluate(() => openModal('sources'));
  await expect(page.locator('#search-index-form')).toBeHidden();
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
  assert.equal(errors.length, 0, errors.join('\n')); assert.ok(calls > 22);
  console.log('Vercel-only browser checks passed: profile/resume/source persistence, Applied/notes, isolated users, quota errors, and bounded scans.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
