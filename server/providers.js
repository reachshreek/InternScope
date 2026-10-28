import { plainText, isoDate } from './text.js';
import { jobTerms } from './matching.js';
import { descriptionQuality } from './quality.js';
import { boardApi, boardFromUrl } from './boards.js';

const INTERNSHIP = /\bintern(?:ship)?s?\b|\bco[ -]?op\b|\bworking student\b/i;
export const isInternship = job => INTERNSHIP.test(`${job.title || ''} ${job.employmentType || ''}`);
export async function fetchJson(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(25000), cache: 'no-store', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': 'Internscope/1.0 (personal internship discovery)' }, redirect: 'error' });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 35_000_000) throw new Error('Source response is too large');
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 35_000_000) { await reader.cancel(); throw new Error('Source response is too large'); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function normalize(job) {
  job.description = plainText(job.description || '');
  job.descriptionQuality = descriptionQuality(job);
  job.terms = [...new Set([...(job.terms || []), ...jobTerms(job.title)])];
  job.years = job.years || [...new Set([...(job.title.match(/\b20\d{2}\b/g) || []), ...([...job.description.matchAll(/\b(?:summer|spring|fall|autumn|winter)\s+(20\d{2})\b/gi)].map(m => m[1]))])];
  if (!job.terms.length) job.terms = jobTerms((job.description.match(/\b(?:summer|spring|fall|autumn|winter)\s+20\d{2}\b/gi) || []).join(' '));
  job.remote = /\bremote\b/i.test(job.location) || !!job.remote;
  return job;
}

export function parseCommunity(rows) {
  if (!Array.isArray(rows)) throw new Error('Unexpected internship feed format');
  return rows.filter(r => r.active !== false && r.is_visible !== false && r.title && r.url).map(r => normalize({
    title: r.title, company: r.company_name, location: (r.locations || []).join(' · '), url: r.url,
    description: r.description || '', postedAt: isoDate(r.date_posted), dateBasis: 'listing',
    terms: jobTerms((r.terms || []).join(' ')), years: [...new Set(((r.terms || []).join(' ').match(/\b20\d{2}\b/g) || []))]
  }));
}
export function parseGreenhouse(data, source) {
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected Greenhouse response');
  return data.jobs.map(r => ({ title: r.title, company: source.name, url: r.absolute_url,
    location: r.location?.name, description: r.content,
    postedAt: isoDate(r.first_published), dateBasis: r.first_published ? 'published' : 'unknown'
  })).filter(isInternship).map(normalize);
}
export function parseLever(data, source) {
  if (!Array.isArray(data)) throw new Error('Unexpected Lever response');
  return data.map(r => ({ title: r.text, company: source.name, url: r.hostedUrl,
    location: [r.categories?.location, ...(r.categories?.allLocations || [])].filter(Boolean).join(' · '),
    employmentType: r.categories?.commitment,
    description: [r.descriptionPlain || r.description, ...(r.lists || []).map(l => `${l.text}\n${plainText(l.content)}`), r.additionalPlain || r.additional].filter(Boolean).join('\n\n'),
    postedAt: isoDate(r.createdAt), dateBasis: r.createdAt ? 'published' : 'unknown', remote: r.workplaceType === 'remote'
  })).filter(isInternship).map(normalize);
}
export function parseAshby(data, source) {
  if (!Array.isArray(data.jobs)) throw new Error('Unexpected Ashby response');
  return data.jobs.filter(r => r.isListed !== false).map(r => ({
    title: r.title, company: source.name, url: r.jobUrl,
    location: [r.location, ...(r.secondaryLocations || []).map(l => l.location)].filter(Boolean).join(' · '),
    employmentType: r.employmentType, description: r.descriptionPlain || r.descriptionHtml,
    postedAt: isoDate(r.publishedAt), dateBasis: r.publishedAt ? 'published' : 'unknown', remote: r.isRemote
  })).filter(isInternship).map(normalize);
}

export async function collectSource(source, fetcher = fetchJson) {
  const token = encodeURIComponent(source.token);
  switch (source.kind) {
    case 'community': {
      const rows = await fetcher(`https://raw.githubusercontent.com/SimplifyJobs/${token}/dev/.github/scripts/listings.json`);
      const jobs = parseCommunity(rows);
      const { discoverBoards } = await import('./discovery.js');
      // Preserve the array API while supplying discovery metadata to the refresh coordinator.
      jobs.discoveredBoards = discoverBoards(rows);
      return jobs;
    }
    case 'greenhouse': {
      // Large boards can exceed 35 MB when all full-time descriptions are included.
      // List lightweight metadata first, then retrieve descriptions for internships only.
      const { url } = boardApi(source);
      const data = await fetcher(url);
      if (!Array.isArray(data.jobs)) throw new Error('Unexpected Greenhouse response');
      const rows = data.jobs.filter(isInternship);
      // The app's persistent detail queue fills these in without delaying discovery.
      if (source.searchOptions?.details === 0) return parseGreenhouse({ jobs: rows }, source);
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (index < Math.min(rows.length, 150)) {
          const at = index++;
          if (!/^\d+$/.test(String(rows[at].id))) continue;
          try { rows[at] = { ...rows[at], ...await fetcher(`${url}/${rows[at].id}`) }; }
          catch { /* Keep readable metadata if an individual description is unavailable. */ }
        }
      }));
      return parseGreenhouse({ jobs: rows }, source);
    }
    case 'lever': return parseLever(await fetcher(`${boardApi(source).url}?mode=json`), source);
    case 'ashby': return parseAshby(await fetcher(boardApi(source).url), source);
    case 'workday': {
      const { collectWorkday } = await import('./workday.js');
      return collectWorkday(source, source.searchOptions);
    }
    case 'linkedin': case 'indeed': case 'ziprecruiter': {
      const { collectWebSource } = await import('./web-sources.js');
      return collectWebSource(source, source.searchOptions);
    }
    case 'runway': case 'internlist': {
      const { collectRunway, collectInternList } = await import('./aggregators.js');
      return source.kind === 'runway' ? collectRunway(source.searchOptions) : collectInternList(source.searchOptions);
    }
    default: throw new Error('Unsupported source');
  }
}

// Fetch structured descriptions only from known ATS APIs; never visit arbitrary submitted URLs.
export async function enrichJobs(jobs, fetcher = fetchJson, limit = 80) {
  const candidates = [...jobs].filter(j => !j.description).sort((a,b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
  let cursor = 0;
  const selected = candidates.slice(0, limit);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < selected.length) {
      const job = selected[cursor++];
      try {
        const url = new URL(job.url);
        const gh = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
        const board = boardFromUrl(job.url);
        if (board?.kind === 'greenhouse' && gh) {
          const data = await fetcher(`${boardApi(board).url}/${gh[2]}`);
          job.description = plainText(data.content);
          if (data.first_published) { job.postedAt = isoDate(data.first_published); job.dateBasis = 'published'; }
        }
        const lever = url.pathname.match(/^\/([^/]+)\/([a-z\d-]+)\/?$/i);
        if (board?.kind === 'lever' && lever) {
          const data = await fetcher(`${boardApi(board).url}/${encodeURIComponent(lever[2])}`);
          const parsed = parseLever([data], { name: job.company })[0];
          if (parsed) job.description = parsed.description;
        }
      } catch { /* Keep title-only listings when individual enrichment is unavailable. */ }
    }
  }));
  return jobs;
}
