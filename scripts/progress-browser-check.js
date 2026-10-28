import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';

const directory = mkdtempSync(join(tmpdir(), 'internscope-progress-'));
const store = openStore(directory), sources = store.sources();
const community = sources.find(s => s.kind === 'community');
const greenhouse = sources.find(s => s.kind === 'greenhouse');
const lever = sources.find(s => s.kind === 'lever');
const ashby = sources.find(s => s.kind === 'ashby');
store.db.prepare('UPDATE sources SET enabled=0').run();
for (const source of [community, greenhouse, lever, ashby]) store.db.prepare('UPDATE sources SET enabled=1 WHERE id=?').run(source.id);
store.db.prepare("UPDATE sources SET origin='discovered' WHERE id=?").run(ashby.id);
const gates = new Map();
let cleaning = false;
const { app, refresher } = createApp({ store, collector: async source => {
  if (cleaning) return [];
  await new Promise(resolve => gates.set(source.token, resolve));
  if (source.token === 'meter-two') throw new Error('Temporary source failure');
  const rows = [];
  if (source.kind === 'community') rows.discoveredBoards = [
    { kind: 'ashby', token: 'meter-one', name: 'First new board' },
    { kind: 'ashby', token: 'meter-two', name: 'Second new board' }
  ];
  return rows;
} });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => state.data !== null);
  await expect(page.locator('#search-progress')).toBeHidden();
  await page.locator('#refresh-button').click();
  await expect(page.locator('#search-progress-percentage')).toHaveText('0%');
  await expect(page.locator('#search-progress-detail')).toContainText('0 of 4 sources checked');
  gates.get(community.token)();
  // Discovery expands the denominator: the first completed feed is 1/6, not 100%.
  await expect(page.locator('#search-progress-percentage')).toHaveText('16%');
  await expect(page.locator('#search-progress-detail')).toContainText('2 new boards found');
  gates.get(greenhouse.token)();
  await expect(page.locator('#search-progress-percentage')).toHaveText('33%');
  gates.get(lever.token)();
  // This change must arrive through normal state polling without reloading.
  await expect(page.locator('#search-progress-percentage')).toHaveText('50%');
  await expect(page.locator('#search-progress-meter')).toHaveAttribute('value', '50');
  await expect(page.locator('#refresh-button')).toContainText('Searching · 50%');
  await expect(page.locator('#refresh-status')).toContainText('50% complete');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/search-progress-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Progress display must fit on mobile');
  await page.locator('#search-progress').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/search-progress-mobile.png', animations: 'disabled' });
  gates.get(ashby.token)();
  await expect(page.locator('#search-progress-percentage')).toHaveText('66%');
  gates.get('meter-one')();
  await expect(page.locator('#search-progress-percentage')).toHaveText('83%');
  gates.get('meter-two')();
  await expect(page.locator('#search-progress-percentage')).toHaveText('100%');
  await expect(page.locator('#search-progress-label')).toHaveText('Search finished');
  await expect(page.locator('#search-progress-detail')).toContainText('1 source needs attention');
  await expect(page.locator('#refresh-button')).toBeEnabled();
  await page.locator('#refresh-button').click();
  await expect(page.locator('#search-progress-percentage')).toHaveText('0%');
  assert.deepEqual(errors, []);
} finally {
  cleaning = true;
  refresher.stop();
  for (const release of gates.values()) release();
  await browser?.close();
  for (let attempt = 0; attempt < 100 && refresher.status().running; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
console.log('Search progress passed: initial total, new board discovery, automatic 0–100% updates, 50% meter/button, failure completion, restart reset, and mobile layout.');
