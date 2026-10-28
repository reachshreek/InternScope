import { collectSource, enrichJobs } from './providers.js';
import { canonicalUrl } from './text.js';
import { discoverBoards } from './discovery.js';
import { boardApi, BOARD_KINDS } from './boards.js';
import { runPool } from './pool.js';

export function createRefresher(store, { hours = 2, collector = collectSource, enrich = enrichJobs, onRefresh = () => {}, backgroundDetails = false, concurrency = Number(process.env.SCAN_CONCURRENCY || 16) } = {}) {
  concurrency = Math.max(1, Math.min(32, Math.floor(Number(concurrency) || 16)));
  let running = false, timer, stopped = false;
  let progress = { checked: 0, total: 0, discovered: 0 };
  const interval = Math.max(.01, hours) * 3600000;
  let checkpoint;
  try { checkpoint = JSON.parse(store.setting('refresh_checkpoint') || 'null'); } catch { /* Ignore obsolete state. */ }
  if (!checkpoint || !Array.isArray(checkpoint.completed) || !store.db.prepare('SELECT id FROM refresh_runs WHERE id=? AND finished_at IS NULL').get(checkpoint.id)) checkpoint = null;
  if (checkpoint) progress = { checked: checkpoint.completed.length, total: checkpoint.total, discovered: checkpoint.discovered };
  // Older versions did not checkpoint; those interrupted runs still need a fresh scan.
  store.db.prepare("UPDATE refresh_runs SET finished_at=?,errors=? WHERE finished_at IS NULL AND id!=?").run(new Date().toISOString(), JSON.stringify(['The previous refresh was interrupted; it will retry.']), checkpoint?.id || -1);
  function status() {
    const last = store.db.prepare('SELECT * FROM refresh_runs ORDER BY id DESC LIMIT 1').get();
    return { running, intervalHours: hours, progress, concurrency, scanScope: 'all_enabled_sources', last: last ? { ...last, errors: JSON.parse(last.errors) } : null,
      nextAt: last?.started_at ? new Date(new Date(last.started_at).getTime() + interval).toISOString() : null };
  }
  async function run() {
    if (running || stopped) return;
    running = true;
    const id = checkpoint?.id || Number(store.db.prepare('INSERT INTO refresh_runs(started_at) VALUES (?)').run(new Date().toISOString()).lastInsertRowid);
    const errors = checkpoint?.errors || [];
    let found = checkpoint?.found || 0;
    let lastQueueSync = Date.now();
    const completed = new Set(checkpoint?.completed || []), queued = new Set(completed);
    progress = { checked: completed.size, total: completed.size, discovered: checkpoint?.discovered || 0 };
    const searchOptions = { profile: store.profile(), apiKey: process.env.SERPAPI_API_KEY || store.setting('serpapi_key'), ...(backgroundDetails ? { details: 0 } : {}) };
    function save() {
      checkpoint = { id, completed: [...completed], found, errors, total: progress.total, discovered: progress.discovered };
      store.setSetting('refresh_checkpoint', JSON.stringify(checkpoint));
    }
    function newSources() {
      const sources = store.sources().filter(s => s.enabled && !queued.has(s.id))
        .sort((a,b) => Number(b.kind === 'community') - Number(a.kind === 'community') || Number(a.origin === 'discovered') - Number(b.origin === 'discovered') || (a.last_attempt || '').localeCompare(b.last_attempt || '') || a.id - b.id);
      for (const source of sources) queued.add(source.id);
      progress.total += sources.length;
      return sources;
    }
    async function check(source, add) {
      store.db.prepare('UPDATE sources SET last_attempt=? WHERE id=?').run(new Date().toISOString(), source.id);
      try {
        const result = await collector({ ...source, searchOptions });
        const jobs = Array.isArray(result) ? result : result.jobs;
        if (!Array.isArray(jobs)) throw new Error('Source returned an invalid result.');
        if (['community', 'runway', 'internlist'].includes(source.kind)) {
          progress.discovered += store.discover(result.discoveredBoards || discoverBoards(jobs.map(j => ({ ...j, company_name: j.company }))));
          add(newSources());
        }
        if (source.kind === 'community' && !backgroundDetails) {
          const known = new Set(store.jobs().filter(j => j.description).map(j => j.url));
          await enrich(jobs.filter(j => !known.has(canonicalUrl(j.url))));
        }
        found += store.ingest(source, jobs, Array.isArray(result) ? {} : result);
        // New listings can receive their details while a long scan is still in progress.
        if (backgroundDetails && Date.now() - lastQueueSync >= 60000) {
          lastQueueSync = Date.now();
          try { onRefresh(); } catch (error) { console.error('Could not update the description queue:', error.message); }
        }
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'Connection timed out; will retry next refresh.' : String(error.message).slice(0, 500);
        errors.push(`${source.name}: ${message}`);
        store.db.prepare('UPDATE sources SET last_error=? WHERE id=?').run(message, source.id);
        // Historical feeds can refer to retired boards. Keep them in the catalog, disabled.
        if (source.origin === 'discovered' && /HTTP (404|410)\b/.test(message)) store.db.prepare('UPDATE sources SET enabled=0 WHERE id=?').run(source.id);
      } finally { completed.add(source.id); progress.checked = completed.size; save(); }
    }
    try {
      const sources = newSources(); save();
      // Slow aggregators/platforms no longer block thousands of independent company boards.
      await runPool(sources, check, { concurrency, stopped: () => stopped,
        key: source => {
          try { return BOARD_KINDS.includes(source.kind) ? new URL(boardApi(source).url).hostname : source.kind; }
          catch { return source.kind; }
        },
        perKey: source => source.kind === 'workday' ? 1 : 4
      });
    } finally {
      if (progress.checked === progress.total) {
        store.db.prepare('UPDATE refresh_runs SET finished_at=?,found=?,errors=? WHERE id=?').run(new Date().toISOString(), found, JSON.stringify(errors), id);
        checkpoint = null; store.setSetting('refresh_checkpoint', 'null');
      }
      running = false;
      try { onRefresh(); } catch (error) { console.error('Could not update the description queue:', error.message); }
      schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    const last = status().last;
    const due = checkpoint ? 1000 : last ? Math.max(1000, new Date(last.started_at).getTime() + interval - Date.now()) : 1000;
    timer = setTimeout(() => { run().catch(console.error); }, due);
    timer.unref?.();
  }
  return { run, status, start: schedule, stop() { stopped = true; clearTimeout(timer); } };
}
