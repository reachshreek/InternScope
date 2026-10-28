import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';

const directory = mkdtempSync(join(tmpdir(), 'internscope-profile-ui-')), store = openStore(directory);
const { app, refresher, enricher } = createApp({ store, collector: async () => [] });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, release;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(base);
  await expect(page.locator('#resume-state')).toHaveText('GET STARTED');
  const stale = await (await page.request.get(base + '/api/state')).json();
  let started;
  const held = new Promise(resolve => { started = resolve; });
  let hold = true;
  await page.route('**/api/state', async route => {
    if (!hold) return route.continue();
    hold = false;
    await new Promise(resolve => { release = resolve; started(); });
    await route.fulfill({ json: stale });
  });
  const oldPoll = page.evaluate(() => loadState());
  await held;
  await page.evaluate(async () => {
    await api('/profile', { method: 'PUT', body: { resume: 'Python software engineering student', resumeName: 'My resume', roles: 'Software engineering', locations: 'Seattle' } });
    await loadState({ refreshJobs: true });
  });
  await expect(page.locator('#resume-state')).toHaveText('READY TO MATCH');
  release(); await oldPoll;
  await expect(page.locator('#resume-state')).toHaveText('READY TO MATCH');
  await expect(page.locator('#preference-summary')).toContainText('Seattle');
  await page.reload();
  await expect(page.locator('#resume-state')).toHaveText('READY TO MATCH');
  assert.equal(store.profile().roles, 'Software engineering');
  console.log('Profile UI passed: delayed empty poll cannot replace saved resume/preferences; reload preserves values.');
} finally {
  release?.(); await browser?.close(); refresher.stop(); enricher.stop(); await enricher.drain();
  await new Promise(resolve => server.close(resolve));
  store.close(); rmSync(directory, { recursive: true, force: true });
}
