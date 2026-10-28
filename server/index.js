import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { openStore, DEFAULT_PROFILE } from './db.js';
import { createRefresher } from './refresh.js';
import { scoreJob, fits, priority, extractSkills, createMatchCache } from './matching.js';
import { resumeText } from './text.js';
import { parseResume } from './resume.js';
import { publicSearchLink, WEB_KINDS } from './web-sources.js';
import { AGGREGATOR_KINDS, AGGREGATOR_URLS } from './aggregators.js';
import { createEnricher } from './enrichment.js';
import { descriptionQuality } from './quality.js';
import { BOARD_KINDS, normalizeBoardToken } from './boards.js';

export function createApp({ store = openStore(), refreshHours = Number(process.env.REFRESH_HOURS || 2), collector, enrich, enrichmentOptions } = {}) {
  const app = express(), enricher = createEnricher(store, enrichmentOptions), refresher = createRefresher(store, { hours: Number.isFinite(refreshHours) && refreshHours > 0 ? refreshHours : 2, collector, enrich, backgroundDetails: true, onRefresh: () => enricher.sync() });
  const matchJob = createMatchCache();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const loopbackOnly = !process.env.HOST || ['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST);
    if (loopbackOnly && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)) return res.status(403).json({ error: 'This workspace only accepts local hostnames.' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Request origin is not allowed.' });
      } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'internscope' }));
  app.get('/api/state', (req, res) => {
    const sources = store.sources(), profile = store.profile();
    const { counts, platformCounts } = store.statistics();
    const coverage = [...BOARD_KINDS, ...WEB_KINDS, ...AGGREGATOR_KINDS].map(kind => {
      const group = sources.filter(s => s.kind === kind);
      return { kind, total: group.length, enabled: group.filter(s => s.enabled).length, checked: group.filter(s => s.last_attempt).length,
        healthy: group.filter(s => s.enabled && s.last_success && !s.last_error).length,
        jobs: platformCounts[kind] || 0,
        searchUrl: WEB_KINDS.includes(kind) ? publicSearchLink(kind, profile) : AGGREGATOR_URLS[kind] || null };
    });
    res.json({ profile, skills: extractSkills(profile.resume), refresh: refresher.status(), enrichment: enricher.status(), sources, coverage,
      integrations: { serpapi: { configured: !!(process.env.SERPAPI_API_KEY || store.setting('serpapi_key')), fromEnvironment: !!process.env.SERPAPI_API_KEY } }, counts });
  });
  app.put('/api/integrations/serpapi', (req, res) => {
    if (process.env.SERPAPI_API_KEY) return res.status(400).json({ error: 'This key is configured in the server environment. Update it there instead.' });
    const key = req.body?.apiKey;
    if (typeof key !== 'string' || (key && !/^[a-zA-Z0-9_-]{20,256}$/.test(key))) return res.status(400).json({ error: 'Enter a valid SerpApi key, or clear the field to disconnect.' });
    store.setSetting('serpapi_key', key);
    res.json({ configured: !!key });
  });
  app.put('/api/profile', (req, res) => {
    const next = { ...store.profile() };
    for (const [key, fallback] of Object.entries(DEFAULT_PROFILE)) {
      if (!(key in (req.body || {}))) continue;
      if (typeof req.body[key] !== typeof fallback) return res.status(400).json({ error: `Invalid value for ${key}.` });
      if (typeof fallback === 'string' && req.body[key].length > (key === 'resume' ? 100000 : 2000)) return res.status(400).json({ error: `${key} is too long.` });
      next[key] = req.body[key];
    }
    if (!['', 'summer', 'spring', 'fall', 'winter'].includes(next.season)) return res.status(400).json({ error: 'Invalid season.' });
    if (next.year && !/^20\d{2}$/.test(next.year)) return res.status(400).json({ error: 'Enter a four-digit year.' });
    next.resume = resumeText(next.resume);
    store.saveProfile(next);
    enricher.sync();
    res.json({ profile: next, skills: extractSkills(next.resume) });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/resume', upload.single('resume'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a resume file.' });
    try {
      const text = await parseResume(req.file);
      const profile = { ...store.profile(), resume: text, resumeName: req.file.originalname.slice(0, 200) };
      store.saveProfile(profile);
      enricher.sync();
      res.json({ profile, skills: extractSkills(text) });
    } catch (error) { res.status(422).json({ error: `Resume could not be read: ${error.message}` }); }
  });
  app.get('/api/jobs', (req, res) => {
    const profile = store.profile(), view = String(req.query.view || 'new');
    const query = String(req.query.q || '').toLowerCase(), sort = String(req.query.sort || 'recommended');
    const minScore = Math.max(0, Math.min(100, Number(req.query.minScore) || 0));
    const maxAge = Math.max(0, Number(req.query.maxAge) || 0);
    let jobs = store.jobs().filter(j => view === 'applied' ? j.status === 'applied' : view === 'saved' ? j.status === 'saved' : j.active && ['new', 'saved'].includes(j.status));
    if (view !== 'applied') jobs = jobs.filter(j => fits(j, profile));
    if (req.query.platform) jobs = jobs.filter(j => j.platforms.includes(String(req.query.platform)));
    if (['title','summary','full'].includes(String(req.query.quality))) jobs = jobs.filter(j => descriptionQuality(j) === req.query.quality);
    jobs = jobs.filter(j => !query || `${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase().includes(query))
      .map(j => ({ ...j, match: matchJob(j, profile) }))
      .filter(j => (!minScore || (j.match.score !== null && j.match.score >= minScore)) && (!maxAge || Date.now() - new Date(j.postedAt || j.firstSeen).getTime() <= maxAge * 86400000));
    jobs.sort((a,b) => sort === 'newest' ? (b.postedAt || b.firstSeen).localeCompare(a.postedAt || a.firstSeen)
      : sort === 'match' ? (b.match.score ?? -1) - (a.match.score ?? -1)
      : sort === 'applied' ? (b.appliedAt || '').localeCompare(a.appliedAt || '')
      : priority(b, b.match.score) - priority(a, a.match.score));
    const total = jobs.length, page = Math.max(1, Math.floor(Number(req.query.page) || 1)), limit = 24;
    res.json({ jobs: jobs.slice((page - 1) * limit, page * limit), total, page, pages: Math.ceil(total / limit) });
  });
  app.get('/api/jobs/:id', (req, res) => {
    const job = store.job(req.params.id);
    if (!job) return res.status(404).json({ error: 'Posting not found.' });
    res.json({ job: { ...job, match: scoreJob(job, store.profile()) }, enrichment: enricher.jobStatus(job.id) });
  });
  app.post('/api/jobs/:id/enrich', (req, res) => {
    const status = enricher.request(req.params.id), job = store.job(req.params.id);
    if (!job) return res.status(404).json({ error: 'Posting not found.' });
    res.status(status?.state === 'done' ? 200 : 202).json({ job: { ...job, match: scoreJob(job, store.profile()) }, enrichment: status });
  });
  app.patch('/api/jobs/:id', (req, res) => {
    if (!store.db.prepare('SELECT id FROM jobs WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Posting not found.' });
    const { status, note } = req.body || {};
    if (status !== undefined && !['new', 'saved', 'applied', 'hidden'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (note !== undefined && (typeof note !== 'string' || note.length > 10000)) return res.status(400).json({ error: 'Notes must be text under 10,000 characters.' });
    const previous = store.db.prepare('SELECT * FROM applications WHERE job_id=?').get(req.params.id);
    const next = status ?? previous?.status ?? 'new';
    store.db.prepare(`INSERT INTO applications VALUES (?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,applied_at=excluded.applied_at,note=excluded.note`)
      .run(req.params.id, next, next === 'applied' ? previous?.applied_at || new Date().toISOString() : null, note ?? previous?.note ?? '');
    if (status !== undefined) enricher.syncJob(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/refresh', (req, res) => {
    if (refresher.status().running) return res.status(202).json({ message: 'Refresh is already running.' });
    refresher.run().catch(console.error);
    res.status(202).json({ message: 'Searching sources for fresh internships.' });
  });
  app.post('/api/cron/refresh', (req, res) => {
    const expected = process.env.CRON_SECRET, actual = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (!expected || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return res.status(401).json({ error: 'Unauthorized' });
    refresher.run().catch(console.error); res.status(202).json({ ok: true });
  });
  app.post('/api/sources', (req, res) => {
    const { kind, name } = req.body || {};
    const token = normalizeBoardToken(kind, req.body?.token);
    if (!token || typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Enter a company name and a valid board identifier or public career board URL. Workday needs its full career board URL.' });
    if (store.sources().some(source => source.kind === kind && source.token.toLowerCase() === token.toLowerCase())) return res.status(409).json({ error: 'That source is already connected.' });
    try {
      store.db.prepare('INSERT INTO sources(kind,name,token) VALUES (?,?,?)').run(kind, name.trim(), token);
      res.status(201).json({ ok: true });
    } catch { res.status(409).json({ error: 'That source is already connected.' }); }
  });
  app.patch('/api/sources/:id', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid enabled value.' });
    const result = store.db.prepare('UPDATE sources SET enabled=? WHERE id=?').run(req.body.enabled ? 1 : 0, req.params.id);
    if (result.changes) enricher.sync();
    res.status(result.changes ? 200 : 404).json(result.changes ? { ok: true } : { error: 'Source not found.' });
  });
  app.get('/api/export', (req, res) => {
    const applications = store.jobs().filter(j => ['applied', 'saved'].includes(j.status)).map(j => ({ company: j.company, title: j.title, url: j.url, status: j.status, appliedAt: j.appliedAt, note: j.note }));
    res.attachment('internscope-applications.json').json(applications);
  });
  app.use(express.static(resolve(dirname(fileURLToPath(import.meta.url)), '../public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error, req, res, next) => {
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Resume files must be 5 MB or smaller.' });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Upload one resume file at a time.' });
    if (error.status === 400 || error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid request body.' });
    console.error(error); res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return { app, store, refresher, enricher };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, refresher, enricher } = createApp();
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3000);
  const server = app.listen(port, host, () => { console.log(`Internscope is running at http://${host}:${port}`); enricher.start(); refresher.start(); });
  server.on('error', error => { console.error(`Could not start Internscope: ${error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { refresher.stop(); enricher.stop(); server.close(() => enricher.drain().finally(() => process.exit(0))); });
}
