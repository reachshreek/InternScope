import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.js';
import { openStore } from '../server/db.js';
const directory = mkdtempSync(join(tmpdir(), 'internscope-detail-ui-')), store = openStore(directory);
const full = 'Build reliable software using Python, SQL, React and Git. Work with experienced engineers on product features, data pipelines, automated tests and practical research. Applicants should be enrolled in a related degree, communicate clearly and enjoy solving problems with teammates. This paid internship offers mentorship and opportunities to learn new skills.';
store.saveProfile({ ...store.profile(), resume: 'Engineering student using Python, SQL, React, Git and automated tests.' });
store.ingest(store.sources()[0], [
  { title: 'Platform Engineering Intern', company: 'Acme', location: 'California', url: 'https://example.com/full', description: full },
  { title: 'Mechanical Engineering Intern', company: 'Orbit', location: 'California', url: 'https://example.com/summary', description: 'Listing summary. CAD and mechanical engineering.' },
  { title: 'Robotics Intern', company: 'Fieldwork', location: 'California', url: 'https://example.com/title', description: '' }
]);
let finish, calls = 0;
const { app, enricher, refresher } = createApp({ store, enrichmentOptions: { intervalMs: 1e6, hostDelayMs: 0, resolver: async item => {
  calls++; await new Promise(resolve => { finish = resolve; }); return { description: full, url: item.url, method: 'browser-fixture' };
} } });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
enricher.start(); let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.job-card').first().waitFor();
  assert.equal(await page.locator('[data-quality="full"]').count(), 1);
  assert.equal(await page.locator('[data-quality="summary"]').count(), 1);
  assert.equal(await page.locator('[data-quality="title"]').count(), 1);
  await page.locator('#quality-filter').selectOption('full');
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 1);
  assert.match(await page.locator('.job-card').textContent(), /Platform Engineering/);
  await page.locator('#quality-filter').selectOption('title');
  await page.waitForFunction(() => document.querySelector('.job-title')?.textContent.includes('Robotics'));
  assert.match(await page.locator('.score').textContent(), /ESTIMATE/);
  await page.locator('.job-title').click();
  await page.waitForFunction(() => document.querySelector('#detail-enrichment-status')?.textContent.includes('Fetching'));
  await page.locator('#job-note').fill('An unsaved note that must survive the description update.');
  assert.equal(calls, 1); finish(); await enricher.drain();
  await page.waitForFunction(() => document.querySelector('#detail-quality')?.textContent === 'Full description');
  assert.match(await page.locator('#detail-description').textContent(), /reliable software/);
  assert.match(await page.locator('#job-note').inputValue(), /unsaved note/);
  assert.match(await page.locator('.detail-score').textContent(), /MATCH/);
  await page.locator('#save-note').click();
  await page.waitForFunction(() => document.querySelector('#toast-message')?.textContent === 'Notes saved.');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/enriched-detail.png', animations: 'disabled' });
  await page.locator('#close-modal').click();
  await page.locator('#quality-filter').selectOption('full');
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/enrichment-mobile.png', fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Description UI passed: three quality levels, full-only filtering, on-open fetch, live score update, preserved unsaved notes, provenance, mobile layout.');
} finally {
  finish?.(); await browser?.close(); enricher.stop(); refresher.stop(); await enricher.drain();
  await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
}
