import { createHash } from 'node:crypto';
import { descriptionQuality, positionKey, compatiblePosition } from './quality.js';
import { scoreJob, fits, priority } from './matching.js';
import { fetchJobDescription, DetailError } from './detail-fetch.js';
import { needsWorkdayMetadata } from './workday-metadata.js';
import { runPool } from './pool.js';
import { boardFromUrl, boardApi } from './boards.js';

const iso = value => new Date(value).toISOString();
function targetHost(job, refs) {
  const host = new URL(job.url).hostname;
  const board = boardFromUrl(job.url);
  if (board && ['greenhouse', 'lever', 'ashby'].includes(board.kind)) return new URL(boardApi(board).url).hostname;
  if (!/greenhouse\.io$|^jobs(?:\.eu)?\.lever\.co$|^jobs\.ashbyhq\.com$|\.myworkdayjobs\.com$/.test(host) && refs.some(ref => ref.kind === 'runway')) return 'app.joinrunway.io';
  return host;
}
export function createEnricher(store, { resolver = fetchJobDescription, batchSize = Number(process.env.ENRICH_BATCH_SIZE || 36), intervalMs = Number(process.env.ENRICH_INTERVAL_SECONDS || 2) * 1000, concurrency = Number(process.env.ENRICH_CONCURRENCY || 6), hostDelayMs = 1200, now = () => Date.now() } = {}) {
  batchSize = Math.max(1, Math.min(100, Number(batchSize) || 36));
  intervalMs = Math.max(1000, Math.min(3600000, Number(intervalMs) || 2000));
  concurrency = Math.max(1, Math.min(12, Math.floor(Number(concurrency) || 6)));
  let started = false, stopped = false, running = false, timer, revision = 0, synced = false;
  const active = new Map(), lastRequest = new Map();
  let slots = concurrency; const waiters = [];
  const acquire = urgent => slots > 0 ? (slots--, Promise.resolve()) : new Promise(resolve => urgent ? waiters.unshift(resolve) : waiters.push(resolve));
  const release = () => { const next = waiters.shift(); if (next) next(); else slots++; };
  store.db.prepare("UPDATE enrichment_queue SET state='retry' WHERE state='working'").run();

  function share(jobs = store.jobs()) {
    const donors = new Map();
    for (const job of jobs) {
      const key = positionKey(job);
      if (key && descriptionQuality(job) === 'full' && job.descriptionMethod !== 'shared') {
        if (!donors.has(key)) donors.set(key, []); donors.get(key).push(job);
      }
    }
    let count = 0;
    for (const job of jobs) {
      if (descriptionQuality(job) === 'full' && job.descriptionMethod !== 'shared') continue;
      const candidates = (donors.get(positionKey(job)) || []).filter(donor => compatiblePosition(job, donor));
      const fingerprints = new Set(candidates.map(donor => createHash('sha256').update(donor.description.trim()).digest('hex')));
      // Ambiguous duplicate titles/requisitions never share differing descriptions.
      if (!candidates.length || fingerprints.size !== 1) continue;
      const donor = candidates[0];
      if (job.descriptionMethod === 'shared' && job.description === donor.description && job.descriptionUrl === (donor.descriptionUrl || donor.url)) continue;
      store.updateDescription(job.id, { description: donor.description, descriptionQuality: 'full', url: donor.descriptionUrl || donor.url, method: 'shared' });
      store.db.prepare('INSERT INTO description_shares VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET donor_id=excluded.donor_id').run(job.id, donor.id);
      if (!needsWorkdayMetadata(job)) store.db.prepare("UPDATE enrichment_queue SET state='done',last_error=NULL WHERE job_id=?").run(job.id);
      count++;
    }
    if (count) revision++;
    return count;
  }
  function sync() {
    const jobs = store.jobs(), shared = share(jobs), profile = store.profile(), date = iso(now());
    const sharedIds = new Set(store.db.prepare('SELECT job_id FROM description_shares').all().map(row => row.job_id));
    const insert = store.db.prepare("INSERT INTO enrichment_queue(job_id,priority,next_attempt,queued_at) VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET priority=excluded.priority,state=CASE WHEN enrichment_queue.state IN ('paused','done') THEN 'pending' ELSE enrichment_queue.state END");
    const done = store.db.prepare("UPDATE enrichment_queue SET state='done',last_error=NULL WHERE job_id=?");
    store.db.exec('BEGIN');
    try {
      for (const job of jobs) {
        if ((descriptionQuality(job) === 'full' || sharedIds.has(job.id)) && !needsWorkdayMetadata(job)) { done.run(job.id); continue; }
        if (!job.active || !['new','saved'].includes(job.status)) {
          store.db.prepare("UPDATE enrichment_queue SET state='paused' WHERE job_id=? AND state IN ('pending','retry','unavailable')").run(job.id); continue;
        }
        const weight = priority(job, scoreJob(job, profile).score, now()) + (fits(job, profile) ? 100 : 0) + (job.status === 'saved' ? 25 : 0);
        insert.run(job.id, weight, date, date);
      }
      store.db.exec('COMMIT'); synced = true;
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return shared;
  }
  function status() {
    const counts = Object.fromEntries(store.db.prepare('SELECT state,count(*) count FROM enrichment_queue GROUP BY state').all().map(row => [row.state, row.count]));
    const quality = Object.fromEntries(store.db.prepare(`SELECT description_quality quality,count(*) count FROM jobs j WHERE EXISTS(SELECT 1 FROM job_sources js JOIN sources s ON js.source_id=s.id WHERE js.job_id=j.id AND js.active=1 AND s.enabled=1) GROUP BY description_quality`).all().map(row => [row.quality, row.count]));
    return { running: running || active.size > 0, enabled: started && !stopped, revision, counts, quality, shared: Number(store.db.prepare('SELECT count(*) count FROM description_shares').get().count), cooldowns: store.db.prepare('SELECT host,until_at untilAt,message FROM enrichment_cooldowns WHERE until_at>?').all(iso(now())) };
  }
  function syncJob(id) {
    const job = store.job(id);
    if (!job) return;
    if (descriptionQuality(job) === 'full' && !needsWorkdayMetadata(job)) {
      store.db.prepare("UPDATE enrichment_queue SET state='done',last_error=NULL WHERE job_id=?").run(id);
    } else if (!job.active || !['new','saved'].includes(job.status)) {
      store.db.prepare("UPDATE enrichment_queue SET state='paused' WHERE job_id=? AND state!='working'").run(id);
    } else {
      const profile = store.profile(), date = iso(now());
      const weight = priority(job, scoreJob(job, profile).score, now()) + (fits(job, profile) ? 100 : 0) + (job.status === 'saved' ? 25 : 0);
      store.db.prepare("INSERT INTO enrichment_queue(job_id,priority,next_attempt,queued_at) VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET priority=excluded.priority,state=CASE WHEN enrichment_queue.state IN ('paused','done') THEN 'pending' ELSE enrichment_queue.state END").run(id, weight, date, date);
    }
  }
  function jobStatus(id) { return store.db.prepare('SELECT state,attempts,next_attempt nextAttempt,last_error lastError FROM enrichment_queue WHERE job_id=?').get(id) || null; }
  async function beforeRequest(host) {
    if (stopped) throw new DetailError('Description worker stopped.');
    const cooldown = store.db.prepare('SELECT until_at FROM enrichment_cooldowns WHERE host=?').get(host);
    if (cooldown && Date.parse(cooldown.until_at) > now()) throw new DetailError('This site is cooling down after a rate limit or access block.', { status: 429, host, retryAfter: Date.parse(cooldown.until_at) });
    const reserved = Math.max(now(), (lastRequest.get(host) || 0) + hostDelayMs);
    lastRequest.set(host, reserved);
    if (reserved > now()) await new Promise(resolve => setTimeout(resolve, reserved - now()));
    if (stopped) throw new DetailError('Description worker stopped.');
    const paused = store.db.prepare('SELECT until_at FROM enrichment_cooldowns WHERE host=?').get(host);
    if (paused && Date.parse(paused.until_at) > now()) throw new DetailError('This site is cooling down.', { status: 429, host, retryAfter: Date.parse(paused.until_at) });
  }
  function processJob(id, urgent = false) {
    if (active.has(id)) return active.get(id);
    const promise = (async () => {
      const job = store.job(id);
      if (!job) return;
      if (descriptionQuality(job) === 'full' && !needsWorkdayMetadata(job)) { store.db.prepare("UPDATE enrichment_queue SET state='done' WHERE job_id=?").run(id); return; }
      const row = jobStatus(id);
      if (!row || Date.parse(row.nextAttempt) > now()) return;
      const refs = store.detailRefs(id), host = targetHost(job, refs);
      const cooldown = store.db.prepare('SELECT until_at FROM enrichment_cooldowns WHERE host=?').get(host);
      if (cooldown && Date.parse(cooldown.until_at) > now()) {
        store.db.prepare("UPDATE enrichment_queue SET state='retry',next_attempt=?,last_error=? WHERE job_id=?").run(cooldown.until_at, 'Waiting for the source cooldown to end.', id); return;
      }
      store.db.prepare("UPDATE enrichment_queue SET state='working',attempts=attempts+1,last_attempt=? WHERE job_id=?").run(iso(now()), id);
      await acquire(urgent);
      try {
        if (stopped) throw new DetailError('Description worker stopped.');
        const result = await resolver(job, refs, { beforeRequest });
        if (descriptionQuality(result) !== 'full') throw new DetailError('Only an abbreviated description was returned.', { permanent: true, host });
        store.updateDescription(id, result);
        store.db.prepare("UPDATE enrichment_queue SET state='done',last_error=NULL WHERE job_id=?").run(id);
        revision++;
      } catch (error) {
        const message = String(error.message || 'Description could not be fetched.').slice(0, 500);
        let due = now() + Math.min(24, 2 ** Math.min(5, row.attempts + 1)) * 3600000;
        if ([401,403,429].includes(error.status)) {
          due = Math.max(now() + (error.status === 429 ? 1 : 6) * 3600000, Number(error.retryAfter) || 0);
          due = Math.min(due, now() + 7 * 86400000);
          store.db.prepare('INSERT INTO enrichment_cooldowns VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET until_at=excluded.until_at,message=excluded.message').run(error.host || host, iso(due), message);
        }
        if (error.permanent) due = now() + 7 * 86400000;
        store.db.prepare('UPDATE enrichment_queue SET state=?,next_attempt=?,last_error=? WHERE job_id=?').run(error.permanent ? 'unavailable' : 'retry', iso(due), message, id);
      } finally { release(); }
    })().finally(() => active.delete(id));
    active.set(id, promise); return promise;
  }
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      if (!synced) sync();
      const due = store.db.prepare(`SELECT q.job_id FROM enrichment_queue q LEFT JOIN applications a ON a.job_id=q.job_id WHERE q.state IN ('pending','retry','unavailable') AND q.next_attempt<=? AND COALESCE(a.status,'new') IN ('new','saved')
        AND EXISTS(SELECT 1 FROM job_sources js JOIN sources s ON s.id=js.source_id WHERE js.job_id=q.job_id AND js.active=1 AND s.enabled=1)
        ORDER BY q.priority + min(40,(julianday(?) - julianday(q.queued_at))*2) DESC,q.queued_at ASC LIMIT ?`).all(iso(now()), iso(now()), batchSize * concurrency);
      // Look ahead within the priority queue so a large board cannot occupy every worker.
      const groups = new Map();
      for (const item of due) {
        const host = targetHost(store.job(item.job_id), store.detailRefs(item.job_id));
        if (!groups.has(host)) groups.set(host, []);
        groups.get(host).push({ ...item, host });
      }
      const selected = [];
      while (groups.size && selected.length < batchSize) {
        for (const [host, items] of groups) {
          selected.push(items.shift());
          if (!items.length) groups.delete(host);
          if (selected.length === batchSize) break;
        }
      }
      await runPool(selected, item => processJob(item.job_id), { concurrency, perKey: 1, stopped: () => stopped,
        key: item => item.host
      });
      share();
    } finally { running = false; schedule(); }
  }
  function schedule() { clearTimeout(timer); if (started && !stopped) { timer = setTimeout(() => run().catch(console.error), Math.max(1000, intervalMs)); timer.unref?.(); } }
  function request(id) {
    const job = store.job(id);
    if (!job) return null;
    if (descriptionQuality(job) !== 'full') share();
    const current = store.job(id);
    if (descriptionQuality(current) === 'full' && !needsWorkdayMetadata(current)) return { state: 'done', message: 'Full description is available.' };
    const date = iso(now());
    store.db.prepare("INSERT INTO enrichment_queue(job_id,priority,next_attempt,queued_at) VALUES (?,10000,?,?) ON CONFLICT(job_id) DO UPDATE SET priority=10000,next_attempt=CASE WHEN state='done' THEN excluded.next_attempt ELSE next_attempt END,state=CASE WHEN state='done' THEN 'pending' ELSE state END").run(id, date, date);
    const row = jobStatus(id);
    if (started && !stopped && Date.parse(row.nextAttempt) <= now()) processJob(id, true).then(() => share()).catch(console.error);
    return jobStatus(id);
  }
  return { sync, syncJob, share, status, jobStatus, request, run, processJob,
    start() { started = true; stopped = false; sync(); schedule(); },
    stop() { stopped = true; clearTimeout(timer); },
    async drain() { await Promise.allSettled([...active.values()]); }
  };
}
