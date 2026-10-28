// One queue for automatic backfill and opened postings, scoped to this tab.
export function createDetailQueue({ fetchDetail, applyDetail, eligible, concurrency = 4, spacing = 750, retryDelay = 30000 }) {
  const entries = new Map(), busy = new Set(), cooldowns = new Map();
  let active = 0, timer, stopped = false;
  function pump() {
    clearTimeout(timer);
    if (stopped) return;
    const now = Date.now();
    const pending = [...entries.values()].filter(e => e.state === 'pending').sort((a, b) => b.priority - a.priority);
    for (const entry of pending) {
      if (active >= concurrency) break;
      if (!entry.manual && !eligible(entry.id)) { entries.delete(entry.id); continue; }
      if (busy.has(entry.host) || Math.max(entry.readyAt, cooldowns.get(entry.host) || 0) > now) continue;
      active++; busy.add(entry.host); entry.state = 'working'; entry.attempts++;
      Promise.resolve().then(() => fetchDetail(entry.id)).then(result => {
        if (stopped) return;
        applyDetail(entry.id, result); entry.state = 'done'; delete entry.lastError;
      }).catch(error => {
        if (stopped) return;
        entry.lastError = error.message;
        const blocked = [403, 429].includes(error.status);
        const wait = blocked ? (error.status === 429 ? 3600000 : 6 * 3600000) : retryDelay * 2 ** (entry.attempts - 1);
        entry.readyAt = Math.max(Date.now() + wait, Number(error.retryAfter) || 0);
        if (blocked) cooldowns.set(entry.host, entry.readyAt);
        entry.state = error.permanent || entry.attempts >= 3 ? 'unavailable' : 'pending';
      }).finally(() => {
        active--; busy.delete(entry.host);
        cooldowns.set(entry.host, Math.max(cooldowns.get(entry.host) || 0, Date.now() + spacing));
        pump();
      });
    }
    const waiting = [...entries.values()].filter(e => e.state === 'pending' && !busy.has(e.host));
    if (active < concurrency && waiting.length) {
      const next = Math.min(...waiting.map(e => Math.max(e.readyAt, cooldowns.get(e.host) || 0)));
      timer = setTimeout(pump, Math.max(1, Math.min(2147483647, next - Date.now())));
    }
  }
  return {
    add(job, { manual = false, priority = 0 } = {}) {
      if (stopped) return;
      let entry = entries.get(job.id);
      if (!entry) {
        entry = { id: job.id, host: new URL(job.url).hostname, state: 'pending', attempts: 0, readyAt: 0, priority, manual };
        entries.set(job.id, entry);
      } else if (entry.state === 'pending') {
        entry.manual ||= manual; entry.priority = entry.manual ? 100 : priority;
      }
      // Batch additions before selecting work, so priorities apply to the whole batch.
      clearTimeout(timer); timer = setTimeout(pump, 0);
    },
    get: id => entries.get(id),
    state() {
      const counts = {};
      for (const entry of entries.values()) counts[entry.state] = (counts[entry.state] || 0) + 1;
      return { running: !!(active || counts.pending), counts, cooldowns: [...cooldowns].filter(([, until]) => until > Date.now() + spacing).map(([host, until]) => ({ host, until })) };
    },
    dispose() { stopped = true; clearTimeout(timer); entries.clear(); }
  };
}
