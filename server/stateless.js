import express from 'express';
import multer from 'multer';
import { collectSource, fetchJson } from './providers.js';
import { fetchSearchHtml } from './web-sources.js';
import { requestPublicJson } from './aggregators.js';
import { BOARD_KINDS, normalizeBoardToken, boardFromUrl } from './boards.js';
import { DEFAULT_SOURCES, PLATFORM_SOURCES, AGGREGATOR_SOURCES } from './defaults.js';
import { discoverBoards } from './discovery.js';
import { parseResume } from './resume.js';
import { fetchJobDescription } from './detail-fetch.js';

export function createStatelessApp({ collector = collectSource, detail = fetchJobDescription } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Request origin is not allowed.' }); }
      catch { return res.status(403).json({ error: 'Invalid origin.' }); }
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'internscope', storage: 'browser' }));
  app.post('/api/scan', async (req, res) => {
    const input = req.body?.source || {};
    const fixed = [...DEFAULT_SOURCES, ...PLATFORM_SOURCES, ...AGGREGATOR_SOURCES].find(([kind,,token]) => input.kind === kind && input.token === token);
    const token = BOARD_KINDS.includes(input.kind) ? normalizeBoardToken(input.kind, input.token) : fixed?.[2];
    if (!token || typeof input.name !== 'string') return res.status(400).json({ error: 'Invalid source.' });
    const deadline = AbortSignal.timeout(45000);
    const boundedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]) });
    const json = url => fetchJson(url, boundedFetch);
    const profile = {};
    for (const key of ['roles', 'locations']) profile[key] = String(req.body.profile?.[key] || '').slice(0, 500);
    profile.remoteOnly = !!req.body.profile?.remoteOnly;
    const source = { kind: input.kind, token, name: input.name.slice(0, 100), searchOptions: {
      profile, details: 0, pages: 2, jobspy: false, apiKey: '',
      jsonFetcher: json, htmlFetcher: url => fetchSearchHtml(url, boundedFetch),
      request: input.kind === 'workday'
        ? (url, body) => requestPublicJson(url, { method: 'POST', body }, boundedFetch)
        : (url, options) => requestPublicJson(url, options, boundedFetch)
    } };
    try {
      const result = await collector(source, json);
      const rows = Array.isArray(result) ? result : result.jobs;
      const boards = result.discoveredBoards || discoverBoards(rows);
      let bytes = Buffer.byteLength(JSON.stringify(boards)), truncated = false;
      const jobs = [];
      for (const row of rows) {
        const job = { ...row, description: String(row.description || '').slice(0, 12000) };
        if (String(row.description || '').length > 12000) job.descriptionQuality = 'summary';
        bytes += Buffer.byteLength(JSON.stringify(job)) + 2;
        if (bytes > 3_800_000) { truncated = true; break; }
        jobs.push(job);
      }
      res.json({ jobs, discoveredBoards: boards, complete: !truncated && (Array.isArray(result) || result.complete !== false),
        warnings: [...(result.warnings || []), ...(truncated ? ['Response size limit reached; previous results were retained.'] : [])], mode: result.mode || 'public' });
    } catch (error) { res.status(502).json({ error: String(error.message).slice(0, 500) }); }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 0 } });
  app.post('/api/resume', upload.single('resume'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a resume file.' });
    try { res.json({ resume: (await parseResume(req.file)).slice(0, 100000), resumeName: req.file.originalname.slice(0, 200) }); }
    catch (error) { res.status(422).json({ error: `Resume could not be read: ${error.message}` }); }
  });
  app.post('/api/detail', async (req, res) => {
    const job = req.body?.job;
    if (!job || !boardFromUrl(job.url) || typeof job.title !== 'string') return res.status(400).json({ error: 'Automatic details are available for supported employer boards. Open the original posting for other sites.' });
    try { res.json(await detail({ url: job.url, title: job.title.slice(0, 500), company: String(job.company || '').slice(0, 200) }, [])); }
    catch (error) { res.status(502).json({ error: String(error.message).slice(0, 500) }); }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error, req, res, next) => res.status(error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Resume files must be under 4 MB.' : 'Invalid request.' }));
  return app;
}
