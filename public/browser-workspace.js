import { DEFAULT_PROFILE, DEFAULT_SOURCES, PLATFORM_SOURCES, AGGREGATOR_SOURCES, WORKDAY_SOURCES } from './shared/defaults.js';
import { createMatchCache, fits, priority, extractSkills } from './shared/matching.js';
import { descriptionQuality, qualityRank } from './shared/quality.js';
import { canonicalUrl, resumeText } from './shared/text.js';
import { normalizeBoardToken, boardApi, boardFromUrl } from './shared/boards.js';
import { postingIdentity } from './shared/posting-identity.js';
import { needsWorkdayMetadata } from './shared/workday-metadata.js';
import { createDetailQueue } from './detail-queue.js';

const prefix = 'internscope.browser.v1.';
export function createBrowserWorkspace({ storage = localStorage, request = fetch, autoStart = true } = {}) {
  const read = (key, fallback) => {
    const value = storage.getItem(prefix + key);
    if (value === null) return fallback;
    try { return JSON.parse(value); } catch { throw new Error('Saved browser data could not be read. Export or recover it before clearing site storage.'); }
  };
  const write = (key, value) => {
    try { storage.setItem(prefix + key, JSON.stringify(value)); }
    catch { throw new Error('Browser storage is full or unavailable. Your change could not be saved.'); }
  };
  const profile = () => ({ ...DEFAULT_PROFILE, ...read('profile', {}) });
  let sources = read('sources', null);
  if (!sources) {
    sources = [...DEFAULT_SOURCES, ...PLATFORM_SOURCES, ...AGGREGATOR_SOURCES, ...WORKDAY_SOURCES].map(([kind, name, token], i) => ({ id: i + 1, kind, name, token, enabled: true, origin: 'manual', count: 0 }));
    write('sources', sources);
  }
  const jobs = new Map(), applications = new Map(), sourceJobs = new Map(), match = createMatchCache();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix + 'application.')) {
      const saved = read(key.slice(prefix.length), null);
      if (saved?.job) { jobs.set(saved.job.id, saved.job); applications.set(saved.job.id, saved); }
    }
  }
  let running = false, revision = 0, saveTimer, storageError = '', last = null;
  let progress = { checked: 0, total: 0, discovered: 0 };
  const saved = id => applications.get(id) || {};
  const storageChanged = event => {
    if (event.key?.startsWith(prefix + 'application.')) {
      const id = event.key.slice((prefix + 'application.').length), value = read('application.' + id, null);
      if (value) { applications.set(id, value); if (!jobs.has(id) && value.job) jobs.set(id, value.job); }
      else applications.delete(id);
    }
    window.dispatchEvent(new Event('internscope-update'));
  };
  window.addEventListener('storage', storageChanged);
  for (const job of jobs.values()) for (const id of job.memberships || []) {
    if (!sourceJobs.has(id)) sourceJobs.set(id, new Set());
    sourceJobs.get(id).add(job.id);
  }
  const viewJob = (job, score = true, currentProfile) => ({ ...job, ...saved(job.id), job: undefined, ...(score ? { match: match(job, currentProfile || profile()) } : {}) });
  async function remote(path, body) {
    const form = body instanceof FormData;
    const response = await request('/api' + path, { method: 'POST', headers: form ? {} : { 'Content-Type': 'application/json' }, body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(65000) });
    let data; try { data = await response.json(); } catch {
      throw new Error(response.status >= 500 ? 'The deployed API could not start or finish this request. Your saved browser data is unchanged. Check the Vercel deployment logs.' : `Request failed (${response.status}). Try again shortly.`);
    }
    if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { status: data.status || response.status, retryAfter: data.retryAfter, permanent: data.permanent });
    return data;
  }
  const needsDetails = job => !!boardFromUrl(job.url) && (descriptionQuality(job) !== 'full' || needsWorkdayMetadata(job));
  const details = createDetailQueue({
    eligible: id => { const job = jobs.get(id); return job?.active && !['hidden', 'applied'].includes(saved(id).status) && needsDetails(job); },
    fetchDetail: id => { const job = jobs.get(id); return remote('/detail', { job: { url: job.url, title: job.title, company: job.company } }); },
    applyDetail: (id, result) => {
      // A source scan may replace the record while this request is in flight.
      const job = jobs.get(id);
      const url = job.url;
      const metadata = { ...job.postingMetadata, ...result.postingMetadata };
      const description = qualityRank(descriptionQuality(result)) >= qualityRank(descriptionQuality(job))
        ? { description: result.description, descriptionQuality: descriptionQuality(result), descriptionUrl: result.url || url, descriptionMethod: result.method || 'employer', descriptionFetchedAt: new Date().toISOString() } : {};
      Object.assign(job, metadata, description, { postingMetadata: metadata });
      if (result.postedAt && (job.dateBasis !== 'published' || result.dateBasis === 'published')) Object.assign(job, { postedAt: result.postedAt, dateBasis: result.dateBasis });
      revision++;
      if (applications.has(id)) {
        const entry = { ...saved(id), job };
        try { write('application.' + id, entry); applications.set(id, entry); } catch (error) { storageError = error.message; }
      }
    }
  });
  function queueDetails(candidates = jobs.values()) {
    const current = profile();
    for (const job of candidates) if (job.active && !['hidden', 'applied'].includes(saved(job.id).status) && needsDetails(job)) {
      details.add(job, { priority: (saved(job.id).status === 'saved' ? 2 : 0) + (fits(job, current) ? 1 : 0) });
    }
  }
  function saveSources(immediate = false) {
    clearTimeout(saveTimer);
    const flush = () => { try { write('sources', sources); } catch (error) { storageError = error.message; } };
    if (immediate) flush(); else saveTimer = setTimeout(flush, 1000);
  }
  function ingest(source, result) {
    const now = new Date().toISOString();
    const enabled = new Set(sources.filter(s => s.enabled).map(s => s.id));
    if (!sourceJobs.has(source.id)) sourceJobs.set(source.id, new Set());
    if (result.complete) for (const id of sourceJobs.get(source.id)) {
      const job = jobs.get(id); if (!job) continue;
      job.memberships = (job.memberships || []).filter(id => id !== source.id);
      job.active = job.memberships.some(id => enabled.has(id));
    }
    if (result.complete) sourceJobs.get(source.id).clear();
    for (const incoming of result.jobs || []) {
      const url = canonicalUrl(incoming.url);
      if (!url || !incoming.title || !incoming.company) continue;
      const id = 'j' + btoa(String.fromCharCode(...new TextEncoder().encode(postingIdentity(url) || url))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const old = jobs.get(id);
      const memberships = [...new Set([...(old?.memberships || []), source.id])];
      const metadata = old?.workdayDetailsFetchedAt ? { ...incoming.postingMetadata, ...old.postingMetadata } : { ...old?.postingMetadata, ...incoming.postingMetadata };
      const job = { ...incoming, ...metadata, postingMetadata: metadata, id, url: old?.url || url, firstSeen: old?.firstSeen || now, lastSeen: now,
        status: 'new', note: '', active: true, memberships, platforms: [...new Set([...(old?.platforms || []), source.kind])],
        sourceNames: [...new Set([...(old?.sourceNames || '').split(', ').filter(Boolean), source.name])].join(', ') };
      if (old && qualityRank(descriptionQuality(old)) > qualityRank(descriptionQuality(job))) Object.assign(job, { description: old.description, descriptionQuality: old.descriptionQuality, descriptionUrl: old.descriptionUrl, descriptionMethod: old.descriptionMethod, descriptionFetchedAt: old.descriptionFetchedAt });
      if (old?.dateBasis === 'published' && incoming.dateBasis !== 'published') Object.assign(job, { postedAt: old.postedAt, dateBasis: old.dateBasis });
      jobs.set(id, job);
      sourceJobs.get(source.id).add(id);
    }
    source.count = sourceJobs.get(source.id).size;
    revision++;
    queueDetails([...sourceJobs.get(source.id)].map(id => jobs.get(id)));
  }
  function host(source) { try { return new URL(boardApi(source).url).hostname; } catch { return source.kind; } }
  async function scan() {
    if (running) return;
    running = true;
    last = { id: Date.now(), started_at: new Date().toISOString(), finished_at: null, errors: [] };
    const pending = sources.filter(s => s.enabled), queued = new Set(pending.map(s => `${s.kind}:${s.token.toLowerCase()}`));
    progress = { checked: 0, total: pending.length, discovered: 0 };
    window.dispatchEvent(new Event('internscope-update'));
    const hosts = new Map(); let active = 0;
    const searchProfile = profile();
    await new Promise(resolve => {
      function pump() {
        while (active < 12) {
          const index = pending.findIndex(s => (hosts.get(host(s)) || 0) < (s.kind === 'workday' ? 1 : 3));
          if (index < 0) break;
          const source = pending.splice(index, 1)[0], key = host(source);
          active++; hosts.set(key, (hosts.get(key) || 0) + 1);
          source.last_attempt = new Date().toISOString();
          remote('/scan', { source: { kind: source.kind, name: source.name, token: source.token }, profile: { roles: searchProfile.roles, locations: searchProfile.locations, remoteOnly: searchProfile.remoteOnly } }).then(result => {
            ingest(source, result);
            source.last_success = new Date().toISOString(); source.last_error = null;
            source.last_warning = (result.warnings || []).join(' '); source.last_mode = result.mode;
            for (const board of result.discoveredBoards || []) {
              const token = normalizeBoardToken(board.kind, board.token);
              if (!token || sources.some(s => s.kind === board.kind && s.token.toLowerCase() === token.toLowerCase())) continue;
              const added = { id: sources.reduce((n,s) => Math.max(n,s.id),0) + 1, kind: board.kind, token, name: String(board.name || token).slice(0,100), enabled: true, origin: 'discovered', count: 0 };
              sources.push(added);
              const identity = `${added.kind}:${token.toLowerCase()}`;
              if (!queued.has(identity)) { queued.add(identity); pending.push(added); progress.total++; progress.discovered++; }
            }
            if (result.discoveredBoards?.length) saveSources(true);
          }).catch(error => { source.last_error = error.message; last.errors.push(`${source.name}: ${error.message}`); }).finally(() => {
            progress.checked++; active--; hosts.set(key, hosts.get(key) - 1); saveSources(); pump();
          });
        }
        if (!active && !pending.length) resolve();
      }
      pump();
    });
    running = false; last.finished_at = new Date().toISOString(); saveSources(true);
    window.dispatchEvent(new Event('internscope-update'));
  }
  let searchConfig;
  async function state() {
    searchConfig ||= remote('/search-config', {}).catch(() => ({ serpapi: { configured: false, fromEnvironment: true, unavailable: true } }));
    const integrations = await searchConfig;
    const all = [...jobs.values()].map(job => viewJob(job, false)), current = profile();
    const counts = { active: all.filter(j => j.active && ['new','saved'].includes(j.status)).length, saved: all.filter(j => j.status === 'saved').length, applied: all.filter(j => j.status === 'applied').length };
    const quality = {}; for (const job of all.filter(j => j.active)) { const q = descriptionQuality(job); quality[q] = (quality[q] || 0) + 1; }
    return { profile: current, skills: extractSkills(current.resume), sources, counts, browserOnly: true, storageError,
      refresh: { running, progress, intervalHours: 2, last },
      enrichment: { ...details.state(), revision, quality },
      integrations,
      coverage: [...new Set(sources.map(s => s.kind))].map(kind => { const group = sources.filter(s => s.kind === kind); return { kind, total: group.length, enabled: group.filter(s => s.enabled).length, checked: group.filter(s => s.last_attempt).length, jobs: all.filter(j => j.active && j.platforms?.includes(kind)).length }; }) };
  }
  async function api(path, options = {}) {
    const url = new URL(path, 'https://workspace.invalid'), method = options.method || 'GET', body = options.body || {};
    if (url.pathname === '/state') return state();
    if (url.pathname === '/profile') {
      const next = profile();
      for (const [key, value] of Object.entries(body)) if (key in DEFAULT_PROFILE) {
        if (typeof value !== typeof DEFAULT_PROFILE[key]) throw new Error(`Invalid ${key}.`);
        next[key] = typeof value === 'string' ? value.slice(0, key === 'resume' ? 100000 : 2000) : value;
      }
      next.resume = resumeText(next.resume); write('profile', next); queueDetails(); return { profile: next, skills: extractSkills(next.resume) };
    }
    if (url.pathname === '/resume') {
      const file = body.get('resume');
      const parsed = file?.name?.toLowerCase().endsWith('.pdf')
        ? await (await import('./pdf-resume.js')).readPdfResume(file)
        : await remote('/resume', body);
      return api('/profile', { method: 'PUT', body: parsed });
    }
    if (url.pathname === '/refresh') { void scan(); return { message: running ? 'Searching while this tab is open.' : 'Search complete.' }; }
    if (url.pathname === '/sources' && method === 'POST') {
      const token = normalizeBoardToken(body.kind, body.token);
      if (!token || !body.name?.trim()) throw new Error('Enter a valid company board.');
      if (sources.some(s => s.kind === body.kind && s.token.toLowerCase() === token.toLowerCase())) throw new Error('That source is already connected.');
      const next = [...sources, { id: sources.reduce((n,s) => Math.max(n,s.id),0)+1, kind: body.kind, token, name: body.name.slice(0,100), enabled: true, count: 0 }];
      write('sources', next); sources = next; return { ok: true };
    }
    if (url.pathname.startsWith('/sources/')) {
      const next = sources.map(s => s.id === Number(url.pathname.split('/').pop()) ? { ...s, enabled: !!body.enabled } : s);
      write('sources', next); sources = next;
      for (const job of jobs.values()) job.active = job.memberships?.some(id => sources.some(s => s.id === id && s.enabled)) || false;
      queueDetails();
      return { ok: true };
    }
    if (url.pathname === '/jobs') {
      const p = profile(), q = (url.searchParams.get('q') || '').toLowerCase(), view = url.searchParams.get('view') || 'new', sort = url.searchParams.get('sort') || 'recommended';
      let rows = [...jobs.values()].map(job => viewJob(job, false)).filter(j => view === 'applied' ? j.status === 'applied' : view === 'saved' ? j.status === 'saved' : j.active && ['new','saved'].includes(j.status));
      if (view !== 'applied') rows = rows.filter(j => fits(j, p));
      rows = rows.map(job => ({ ...job, match: match(job, p) }));
      rows = rows.filter(j => (!q || `${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase().includes(q)) && (!url.searchParams.get('platform') || j.platforms?.includes(url.searchParams.get('platform'))) && (!url.searchParams.get('quality') || descriptionQuality(j) === url.searchParams.get('quality')) && (!Number(url.searchParams.get('minScore')) || j.match.score >= Number(url.searchParams.get('minScore'))) && (!Number(url.searchParams.get('maxAge')) || Date.now()-Date.parse(j.postedAt || j.firstSeen) <= Number(url.searchParams.get('maxAge'))*86400000));
      rows.sort((a,b) => sort === 'newest' ? (b.postedAt || b.firstSeen).localeCompare(a.postedAt || a.firstSeen) : sort === 'match' ? (b.match.score ?? -1)-(a.match.score ?? -1) : sort === 'applied' ? (b.appliedAt || '').localeCompare(a.appliedAt || '') : priority(b,b.match.score)-priority(a,a.match.score));
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      return { jobs: rows.slice((page-1)*24,page*24), total: rows.length, page, pages: Math.ceil(rows.length/24) };
    }
    if (url.pathname.startsWith('/jobs/')) {
      const parts = url.pathname.split('/'), id = parts[2], job = jobs.get(id);
      if (!job) throw new Error('Posting not found.');
      if (method === 'PATCH') {
        const old = saved(id), status = body.status ?? old.status ?? 'new';
        if (!['new','saved','applied','hidden'].includes(status)) throw new Error('Invalid status.');
        const entry = { status, note: String(body.note ?? old.note ?? '').slice(0,10000), appliedAt: status === 'applied' ? old.appliedAt || new Date().toISOString() : null, job };
        write('application.' + id, entry); applications.set(id, entry);
        queueDetails([job]);
        return { ok: true };
      }
      if (parts[3] === 'enrich' && needsDetails(job)) details.add(job, { manual: true, priority: 100 });
      if (descriptionQuality(job) !== 'full' && !boardFromUrl(job.url)) return { job: viewJob(job), enrichment: { state: 'unavailable', lastError: 'Automatic details are unavailable for this site. Open the original posting.' } };
      return { job: viewJob(job), enrichment: details.get(id) || { state: 'pending' } };
    }
    if (url.pathname === '/export') return [...jobs.values()].map(job => viewJob(job, false)).filter(j => ['saved','applied'].includes(j.status)).map(({ company,title,url,status,appliedAt,note }) => ({ company,title,url,status,appliedAt,note }));
    throw new Error('This feature is unavailable in browser-only mode.');
  }
  const startTimer = autoStart ? setTimeout(() => { queueDetails(); void scan(); }, 1000) : null;
  const timer = autoStart ? setInterval(() => { if (!running) void scan(); }, 2*3600000) : null;
  return { api, scan, dispose() { details.dispose(); clearTimeout(startTimer); clearInterval(timer); clearTimeout(saveTimer); window.removeEventListener('storage', storageChanged); }, jobs };
}
