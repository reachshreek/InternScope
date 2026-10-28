import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { createApp } from '../server/index.js';

const directory = mkdtempSync(join(tmpdir(), 'internscope-status-ui-')), store = openStore(directory);
const full = 'Build reliable software using Python, SQL, React and Git. Work with engineers on product features, data pipelines, automated tests and practical research. Applicants should be enrolled in a related degree, communicate clearly and enjoy solving problems with teammates. This internship offers mentorship and opportunities to learn new skills.';
store.ingest(store.sources()[0], ['Alpha','Beta','Gamma'].map(company => ({ title: `${company} Software Intern`, company, location: 'California', url: `https://example.com/${company}`, description: full })));
const jobs = store.jobs(), alpha = jobs.find(job => job.company === 'Alpha'), beta = jobs.find(job => job.company === 'Beta'), gamma = jobs.find(job => job.company === 'Gamma');
const { app, enricher, refresher } = createApp({ store }), server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const gates = [], errors = [];
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/jobs/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const gate = { route, id: route.request().url().split('/').at(-1) };
    await new Promise(resolve => { gate.finish = resolve; gates.push(gate); });
    if (gate.reject) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test save failed.' }) });
    else await route.continue();
  });
  await page.goto(base); await page.locator('.job-card').first().waitFor();
  const card = job => page.locator(`.job-card[data-job="${job.id}"]`);
  const gateFor = async id => {
    await page.waitForFunction(() => true); // Flush the browser's event dispatch.
    for (let attempts = 0; attempts < 100 && !gates.some(gate => gate.id === id); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    const gate = gates.find(gate => gate.id === id); assert.ok(gate, 'The status request must start.'); return gate;
  };

  // Hold an old feed response across the action; it must never bring the card back.
  const staleFeed = await (await page.request.get(`${base}/api/jobs`)).json();
  let releaseFeed, feedStarted;
  const started = new Promise(resolve => { feedStarted = resolve; });
  await page.route('**/api/jobs?*', async route => {
    feedStarted(); await new Promise(resolve => { releaseFeed = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleFeed) });
  });
  const staleRequest = page.evaluate(() => loadJobs()); await started;
  await card(alpha).getByRole('button', { name: 'Applied', exact: true }).click();
  const alphaGate = await gateFor(alpha.id);
  assert.equal(await card(alpha).count(), 0, 'Applied disappears before the server responds.');
  assert.equal(store.job(alpha.id).status, 'new', 'The request is still deliberately held.');
  assert.equal(await page.locator('#nav-applied').textContent(), '1');
  releaseFeed(); await staleRequest; await page.unroute('**/api/jobs?*');
  assert.equal(await card(alpha).count(), 0, 'An old feed response cannot resurrect Applied.');

  await card(beta).getByRole('button', { name: 'View job' }).click();
  await page.getByRole('button', { name: 'Hide posting', exact: true }).click();
  const betaGate = await gateFor(beta.id);
  assert.equal(await page.locator('#modal').isVisible(), false, 'Hide closes the dialog before the response.');
  assert.equal(await card(beta).count(), 0);
  const betaDone = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${beta.id}`) && response.request().method() === 'PATCH');
  betaGate.finish(); await betaDone;
  assert.equal(await card(alpha).count(), 0);
  const alphaDone = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${alpha.id}`) && response.request().method() === 'PATCH');
  alphaGate.finish(); await alphaDone;
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 1 && document.querySelector('#result-total').textContent === '1');
  assert.equal(store.job(alpha.id).status, 'applied'); assert.equal(store.job(beta.id).status, 'hidden');

  // Undo restores the correct job after multiple out-of-order responses.
  gates.length = 0;
  await page.locator('#toast-undo').click();
  const undoGate = await gateFor(alpha.id);
  undoGate.finish();
  await page.waitForFunction(() => document.querySelectorAll('.job-card').length === 2);
  assert.equal(store.job(alpha.id).status, 'new');

  // A failed save rolls back both the removed card and optimistic counters.
  gates.length = 0;
  await card(gamma).getByRole('button', { name: 'View job' }).click();
  await page.getByRole('button', { name: 'Hide posting', exact: true }).click();
  const failedGate = await gateFor(gamma.id);
  assert.equal(await card(gamma).count(), 0);
  failedGate.reject = true; failedGate.finish();
  await card(gamma).waitFor();
  assert.equal(store.job(gamma.id).status, 'new');
  assert.match(await page.locator('#toast-message').textContent(), /could not be saved/);
  assert.equal(await page.locator('#nav-new').textContent(), '2');

  // A double click on the same posting makes only one pending write.
  gates.length = 0;
  await card(gamma).getByRole('button', { name: /^Save / }).click();
  const saveGate = await gateFor(gamma.id);
  await card(gamma).getByRole('button', { name: /^Unsave / }).click();
  assert.equal(gates.length, 1);
  saveGate.finish();
  await page.waitForFunction(() => document.querySelector('#nav-saved').textContent === '1');
  assert.deepEqual(errors, []);
  console.log('Fast status UI passed: immediate Apply/Hide, stale-response protection, concurrent actions, Undo, failed-save rollback, duplicate-click prevention.');
} finally {
  for (const gate of gates) gate.finish?.();
  await browser?.close(); enricher.stop(); refresher.stop();
  await new Promise(resolve => server.close(resolve));
  store.close(); rmSync(directory, { recursive: true, force: true });
}
