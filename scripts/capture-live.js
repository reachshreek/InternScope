import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3000');
  await page.locator('.job-card').first().waitFor();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/live-desktop.png' });
  await page.locator('.job-card').first().getByRole('button', { name: 'View job' }).click();
  await page.locator('.detail-description').waitFor();
  await page.screenshot({ path: 'test-results/live-details.png' });
  await page.locator('#close-modal').click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Live mobile feed overflows');
  await page.screenshot({ path: 'test-results/live-mobile.png', animations: 'disabled' });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Live interface verified with real listings at desktop and mobile sizes.');
} finally { await browser.close(); }
