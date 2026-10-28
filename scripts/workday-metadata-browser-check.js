import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { openStore } from '../server/db.js';
import { workdayMetadata } from '../server/workday-metadata.js';
const dir = mkdtempSync(join(tmpdir(), 'workday-metadata-ui-')), store = openStore(dir);
const full = 'Build software with Python and SQL while learning from experienced engineers. '.repeat(8);
store.ingest(store.sources().find(s => s.kind === 'workday'), [{ title: 'Software Intern', company: 'Example', location: 'Boston', url: 'https://example.wd1.myworkdayjobs.com/External/job/Boston/Intern_JR123', description: full }]);
let release;
const { app, enricher, refresher } = createApp({ store, enrichmentOptions: { intervalMs: 1e6, resolver: async job => {
  await new Promise(resolve => { release = resolve; });
  return { description: full, url: job.url, method: 'employer-workday-api', ...workdayMetadata({ startDate: '2026-10-20', location: 'Boston', additionalLocations: ['New York'], timeType: 'Full time', remoteType: 'Hybrid', jobReqId: 'JR123' }, { detail: true }) };
} } });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
enricher.start(); let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.job-title').click();
  await expect(page.locator('#detail-enrichment-status')).toContainText('Fetching the posting date');
  await page.locator('#job-note').fill('Keep my unsaved draft');
  await expect.poll(() => typeof release).toBe('function'); release();
  await expect(page.locator('#posting-facts')).toContainText('Hybrid');
  await expect(page.locator('#posting-facts')).toContainText('Full time');
  await expect(page.locator('#posting-facts')).toContainText('JR123');
  await expect(page.locator('#posting-facts')).toContainText('New York');
  await expect(page.locator('.detail-dates')).toContainText('Published:');
  await expect(page.locator('#job-note')).toHaveValue('Keep my unsaved draft');
  await page.locator('#close-modal').click();
  await expect(page.locator('.job-meta')).toContainText('Hybrid');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} finally {
  release?.(); await browser?.close(); enricher.stop(); refresher.stop(); await enricher.drain();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true });
}
console.log('Workday metadata UI passed: full-description backfill, live facts/date updates, preserved draft, card metadata, and mobile layout.');
