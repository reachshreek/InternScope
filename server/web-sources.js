import { load } from 'cheerio';
import { plainText, canonicalUrl, isoDate } from './text.js';
import { split } from './matching.js';
import { normalize, isInternship, fetchJson } from './providers.js';
import { JOBSPY_KINDS, jobSpyEnabled, jobSpyInput, runJobSpy } from './jobspy.js';

export const WEB_KINDS = ['linkedin', 'indeed', 'ziprecruiter'];
const HOSTS = { linkedin: 'www.linkedin.com', indeed: 'www.indeed.com', ziprecruiter: 'www.ziprecruiter.com' };
export class SourceAccessError extends Error {
  constructor(message, code = 'restricted') { super(message); this.code = code; }
}

export function searchQueries(profile = {}) {
  // Only explicit search preferences leave the app. Resume text is never used in requests.
  const roles = ['', ...split(profile.roles).slice(0, 2)], locations = split(profile.locations).slice(0, 3);
  const queries = [];
  for (const role of roles) for (const location of locations.length ? locations : ['']) {
    queries.push({ keywords: `${role} internship`.trim(), location });
  }
  return queries.slice(0, 6);
}
export function searchUrl(kind, query, page = 0, offset) {
  const url = new URL(kind === 'linkedin' ? 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
    : kind === 'indeed' ? 'https://www.indeed.com/jobs' : 'https://www.ziprecruiter.com/jobs-search');
  if (kind === 'linkedin') {
    url.search = new URLSearchParams({ keywords: query.keywords, f_JT: 'I', sortBy: 'DD', f_TPR: 'r604800', start: String(offset ?? page * 25) });
    if (query.location) url.searchParams.set('location', query.location);
  } else if (kind === 'indeed') {
    url.search = new URLSearchParams({ q: query.keywords, sort: 'date', fromage: '7', jt: 'internship', start: String(offset ?? page * 10) });
    if (query.location) url.searchParams.set('l', query.location);
  } else {
    url.search = new URLSearchParams({ search: query.keywords, days: '7', page: String(page + 1) });
    if (query.location) url.searchParams.set('location', query.location);
  }
  return url.toString();
}
export function publicSearchLink(kind, profile = {}) {
  const query = searchQueries(profile)[0];
  if (kind === 'linkedin') {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    url.search = new URLSearchParams({ keywords: query.keywords, location: query.location, f_JT: 'I', sortBy: 'DD', f_TPR: 'r604800' });
    return url.toString();
  }
  return searchUrl(kind, query);
}
export async function fetchSearchHtml(url, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(25000), redirect: 'manual', cache: 'no-store', headers: { Accept: 'text/html', 'Cache-Control': 'no-cache', Pragma: 'no-cache', 'User-Agent': 'Internscope/1.0 (personal internship discovery)' } }); }
  catch { throw new SourceAccessError('Could not connect to the public search page. Will retry on the next refresh.', 'network'); }
  if (response.status === 429) throw new SourceAccessError('Rate limited (HTTP 429). Paused until the next scheduled refresh.', 'rate_limited');
  if ([401,403,999].includes(response.status) || (response.status >= 300 && response.status < 400)) throw new SourceAccessError(`Public search is restricted (HTTP ${response.status}). Add a SerpApi key for indexed results or open the site directly.`);
  if (!response.ok) throw new SourceAccessError(`Search returned HTTP ${response.status}.`, 'network');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 5_000_000) { await reader.cancel(); throw new SourceAccessError('Search response exceeded the size limit.', 'format'); }
    chunks.push(Buffer.from(value));
  }
  const html = Buffer.concat(chunks).toString('utf8');
  if (/<title[^>]*>[^<]*(?:security check|just a moment|access denied|sign in)/i.test(html) || /verify (?:that )?you are (?:a )?human/i.test(html)) throw new SourceAccessError('The site returned a security check. Add a SerpApi key for indexed results or open the site directly.');
  return html;
}
export function approximateDate(value, now = Date.now()) {
  const text = String(value || '').replace(/\+/g, '');
  const match = text.match(/(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i);
  if (match) {
    const unit = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }[match[2].toLowerCase()];
    return new Date(now - Number(match[1]) * unit).toISOString();
  }
  if (/\b(today|just posted|just now)\b/i.test(text)) return new Date(now).toISOString();
  if (/\byesterday\b/i.test(text)) return new Date(now - 86400000).toISOString();
  return null;
}
function jobUrl(value, kind) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, `https://${HOSTS[kind]}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const domain = HOSTS[kind].replace(/^www\./, '');
    if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return null;
    if (kind === 'linkedin') {
      const id = url.pathname.match(/(?:-|\/)(\d{6,})\/?$/)?.[1];
      if (id) return `https://www.linkedin.com/jobs/view/${id}`;
      return null;
    }
    if (kind === 'indeed') {
      const id = url.searchParams.get('jk') || url.searchParams.get('vjk');
      if (id && /^[a-z\d]+$/i.test(id)) return `https://www.indeed.com/viewjob?jk=${id}`;
      return null;
    }
    return canonicalUrl(url.toString());
  } catch { return null; }
}
function unique(jobs) { return [...new Map(jobs.filter(j => j.url && j.title && j.company && isInternship(j)).map(j => [j.url, normalize(j)])).values()]; }
function structuredJobs($, kind) {
  const jobs = [];
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().includes('JobPosting')) {
      const places = [value.jobLocation].flat().filter(Boolean).map(l => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry].filter(Boolean).join(', '));
      jobs.push({ title: value.title, company: value.hiringOrganization?.name, location: places.join(' · '), url: jobUrl(value.url || value.mainEntityOfPage?.['@id'], kind), description: value.description, postedAt: isoDate(value.datePosted), dateBasis: 'published', employmentType: [value.employmentType].flat().join(' '), remote: value.jobLocationType === 'TELECOMMUTE' });
    }
    for (const key of ['@graph', 'itemListElement', 'item']) if (value[key]) visit(value[key]);
  }
  $('script[type="application/ld+json"]').each((i, el) => { try { visit(JSON.parse($(el).text())); } catch { /* Ignore unrelated or invalid JSON-LD. */ } });
  return jobs;
}
export function parseSearchHtml(kind, html) {
  const $ = load(html), jobs = structuredJobs($, kind);
  if (kind === 'linkedin') {
    $('.base-search-card, .job-search-card').each((i, el) => {
      const card = $(el), time = card.find('time'), exact = isoDate(time.attr('datetime'));
      jobs.push({ title: card.find('.base-search-card__title').text().trim(), company: card.find('.base-search-card__subtitle').text().trim(),
        location: card.find('.job-search-card__location').text().trim(), url: jobUrl(card.find('a.base-card__full-link').attr('href'), kind),
        description: '', postedAt: exact || approximateDate(time.text()), dateBasis: exact ? 'published' : 'estimated' });
    });
  } else if (kind === 'indeed') {
    $('.job_seen_beacon').each((i, el) => {
      const card = $(el), link = card.find('h2.jobTitle a, a.jcs-JobTitle').first(), id = link.attr('data-jk') || card.find('[data-jk]').first().attr('data-jk');
      jobs.push({ title: link.text().trim(), company: card.find('[data-testid="company-name"], .companyName').first().text().trim(),
        location: card.find('[data-testid="text-location"], .companyLocation').first().text().trim(), url: jobUrl(id ? `/viewjob?jk=${id}` : link.attr('href'), kind),
        description: card.find('.job-snippet, [data-testid="jobsnippet_footer"]').text().trim(), postedAt: approximateDate(card.find('.date').text()), dateBasis: 'estimated' });
    });
  } else {
    $('article.job_result, .job_result, [data-testid="job-card"]').each((i, el) => {
      const card = $(el), link = card.find('a.job_link, a[data-testid="job-card-title"], h2 a').first();
      jobs.push({ title: link.text().trim(), company: card.find('.hiring_company, [data-testid="company-name"]').first().text().trim(),
        location: card.find('.location, [data-testid="job-card-location"]').first().text().trim(), url: jobUrl(link.attr('href'), kind),
        description: card.find('.job_snippet, [data-testid="job-card-description"]').text().trim(), postedAt: approximateDate(card.find('time, .posted_time').text()), dateBasis: 'estimated' });
    });
  }
  const result = unique(jobs);
  if (!result.length && !/no (?:matching )?(?:jobs|results)|couldn't find|did not match any jobs|jobs you were looking for/i.test($('body').text()) && !$('.base-search-card, .job-search-card, .job_seen_beacon, .job_result, [data-testid="job-card"]').length && !jobs.length) throw new SourceAccessError('Search page format was not recognized. Existing results were kept.', 'format');
  const cardCount = kind === 'linkedin' ? $('.base-search-card, .job-search-card').length : kind === 'indeed' ? $('.job_seen_beacon').length : $('.job_result, [data-testid="job-card"]').length;
  Object.defineProperty(result, 'resultCount', { value: cardCount || jobs.length, enumerable: false });
  return result;
}

export function parseIndexedJobs(data, kind) {
  if (data.error) throw new SourceAccessError('Search-index provider returned an error. Check your key, quota, and search settings.', 'configuration');
  if (!Array.isArray(data.jobs_results) && !/empty/i.test(data.search_information?.jobs_results_state || '')) throw new SourceAccessError('Unexpected search-index response.', 'format');
  return unique((data.jobs_results || []).flatMap(row => {
    const option = (row.apply_options || []).find(o => jobUrl(o.link, kind));
    if (!option) return [];
    return [{ title: row.title, company: row.company_name, location: row.location, url: jobUrl(option.link, kind), description: row.description,
      postedAt: approximateDate(row.detected_extensions?.posted_at), dateBasis: 'estimated', employmentType: row.detected_extensions?.schedule_type,
      remote: row.detected_extensions?.work_from_home }];
  }));
}
export function parseJobSpyRows(kind, rows) {
  return unique(rows.filter(row => row && typeof row.title === 'string' && typeof row.company === 'string').map(row => {
    // pandas serializes date-only values as naive midnight timestamps. Preserve
    // that calendar date in UTC instead of interpreting it in the server's zone.
    const rawDate = row.date_posted;
    const postedAt = isoDate(typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawDate) ? `${rawDate}Z` : rawDate);
    return { title: row.title, company: row.company, location: typeof row.location === 'string' ? row.location : 'Not specified',
      url: jobUrl(row.job_url, kind), description: typeof row.description === 'string' ? row.description : '',
      postedAt, dateBasis: postedAt ? 'listing' : 'unknown',
      employmentType: Array.isArray(row.job_type) ? row.job_type.join(' ') : String(row.job_type || ''), remote: row.is_remote === true };
  }));
}
export async function collectWebSource(source, { profile = {}, htmlFetcher = fetchSearchHtml, jsonFetcher = fetchJson, apiKey = process.env.SERPAPI_API_KEY || '', preferIndexed = false, queryLimit = 6, jobspy = jobSpyEnabled(), jobspyFetcher = runJobSpy, pages = Number(process.env.SEARCH_PAGES || 3), details = Number(process.env.SEARCH_DETAILS || 10), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const candidates = searchQueries(profile);
  if (preferIndexed && apiKey) candidates.sort((a, b) => Number(a.keywords === 'internship') - Number(b.keywords === 'internship'));
  const queries = candidates.slice(0, Math.max(1, Math.min(6, queryLimit))), jobs = [], warnings = [];
  if (jobspy && JOBSPY_KINDS.includes(source.kind)) {
    try {
      const result = await jobspyFetcher(jobSpyInput(source.kind, queries, { remoteOnly: profile.remoteOnly }));
      if (!Array.isArray(result.rows)) throw new Error('JobSpy returned an unexpected result.');
      return { jobs: parseJobSpyRows(source.kind, result.rows), complete: false, mode: 'jobspy', warnings: [...(result.warnings || []), ...(result.partial ? ['JobSpy returned partial results; previously found postings were retained.'] : [])] };
    } catch (error) { warnings.push(`JobSpy unavailable: ${String(error.message).slice(0,500)} Using the existing search fallback.`); }
  }
  const maxPages = Math.max(1, Math.min(10, Number(pages) || 3));
  if (!(preferIndexed && apiKey)) {
  try {
    for (const query of queries) {
      let offset = 0;
      for (let page = 0; page < maxPages; page++) {
        if (page || jobs.length) await pause(600);
        const rows = parseSearchHtml(source.kind, await htmlFetcher(searchUrl(source.kind, query, page, offset)));
        jobs.push(...rows);
        offset += rows.resultCount || rows.length;
        if (!(rows.resultCount || rows.length)) break;
      }
    }
    const result = unique(jobs);
    if (source.kind === 'linkedin') {
      for (const job of [...result].sort((a,b) => (b.postedAt || '').localeCompare(a.postedAt || '')).slice(0, Math.max(0, Math.min(30, details || 0)))) {
        try {
          await pause(600);
          const id = job.url.split('/').pop();
          const $ = load(await htmlFetcher(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`));
          const description = plainText($('.show-more-less-html__markup').first().html() || '');
          if (description) Object.assign(job, normalize({ ...job, description, descriptionQuality: 'full' }));
        } catch (error) { warnings.push(`Some descriptions were unavailable. ${error.message}`); break; }
      }
    }
    return { jobs: result, complete: false, mode: 'public', warnings };
  } catch (error) {
    if (!apiKey) {
      if (jobs.length) return { jobs: unique(jobs), complete: false, mode: 'public', warnings: [...warnings, error.message] };
      if (warnings.length) throw new SourceAccessError(`${warnings.join(' ')} Public fallback: ${error.message}`, error.code);
      throw error;
    }
    warnings.push(`Direct search unavailable; using indexed results. ${error.code === 'rate_limited' ? 'Direct search was rate limited.' : ''}`.trim());
  }
  }
  // No login/captcha handling or proxy rotation: query an independent job index when configured.
  // One request per query keeps provider credit usage predictable. Key is never returned to clients.
  for (const query of queries) {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({ engine: 'google_jobs', q: `${query.keywords}${profile.remoteOnly ? ' remote' : ''}${query.location ? ` in ${query.location}` : ''}`, api_key: apiKey, no_cache: preferIndexed ? 'false' : 'true' });
    try { jobs.push(...parseIndexedJobs(await jsonFetcher(url.toString()), source.kind)); }
    catch {
      if (jobs.length) return { jobs: unique(jobs), complete: false, mode: 'indexed', warnings: [...warnings, 'Indexed search failed on a later query; partial results were kept.'] };
      throw new SourceAccessError('Indexed search failed. Check your SerpApi key and quota. Existing results were kept.', 'configuration');
    }
  }
  return { jobs: unique(jobs), complete: false, mode: 'indexed', warnings };
}
