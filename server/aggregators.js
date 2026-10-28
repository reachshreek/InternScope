import { load } from 'cheerio';
import { fetchJson, normalize, isInternship } from './providers.js';
import { canonicalUrl, plainText, isoDate } from './text.js';
import { jobTerms } from './matching.js';
import { SourceAccessError } from './web-sources.js';

export const AGGREGATOR_KINDS = ['runway', 'internlist'];
export const AGGREGATOR_URLS = { runway: 'https://app.joinrunway.io/explore', internlist: 'https://www.intern-list.com/?k=eng' };

// These are read-only listing requests made by the sites' public, logged-out clients.
// Intern List's embedded table uses POST for search; it does not create applications or accounts.
export async function requestPublicJson(url, { method = 'GET', body } = {}, fetcher = fetch) {
  return fetchJson(url, (target, options) => fetcher(target, {
    ...options, method,
    headers: { ...options.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
}
function runwayData(data) {
  if (data?.error) throw new SourceAccessError('Runway public listing access is unavailable. Existing results were kept.', 'restricted');
  const value = data?.result?.data?.json;
  if (!value || typeof value !== 'object') throw new Error('Runway changed its public data format. Existing results were kept.');
  return value;
}
export function runwayUrl(method, input) {
  if (!['jobPosting.getJobs', 'flightBoard.getJobPostingById'].includes(method)) throw new Error('Unsupported Runway listing method');
  const url = new URL(`https://app.joinrunway.io/api/trpc/${method}`);
  const envelope = { json: input };
  // Runway's public tRPC client uses SuperJSON: the cursor date must revive as a Date.
  if (input.cursor?.lastPostedAt) envelope.meta = { values: { 'cursor.lastPostedAt': ['Date'] }, v: 1 };
  url.searchParams.set('input', JSON.stringify(envelope));
  return url.toString();
}
export function parseRunway(data) {
  const value = runwayData(data);
  if (!Array.isArray(value.jobs)) throw new Error('Runway returned an invalid job list.');
  return value.jobs.filter(r => r.jobType !== 'PROJECT').map(r => {
    const employmentType = String(r.employmentType || r.seniorityLevel || '').replaceAll('_', ' ');
    const description = r.descriptionHtml || r.description || [r.responsibilitySummary, r.qualificationSummary].filter(Boolean).join('\n\n');
    return normalize({ id: r.id, title: r.title || '', company: r.company || r.companyName || r.brandFetchDomain || 'Company not specified',
      url: canonicalUrl(r.applyUrl) || canonicalUrl(r.shortenedUrl), location: r.location || 'Not specified', description,
      employmentType, postedAt: isoDate(r.postedAt), dateBasis: 'listing', remote: /REMOTE/.test(r.workArrangement || ''),
      descriptionQuality: r.descriptionHtml || r.description ? undefined : 'summary', detailRefs: [{ kind: 'runway', externalId: r.id, url: r.shortenedUrl }] });
  }).filter(j => j.url && j.title && isInternship(j));
}
export function parseInternList(data, region = 'us') {
  if (data?.success === false || data?.error) throw new SourceAccessError('Intern List public listing access is unavailable. Existing results were kept.', 'restricted');
  const result = data?.result;
  if (!result || !Array.isArray(result.jobList) || !Number.isFinite(Number(result.total))) throw new Error('Intern List changed its public data format. Existing results were kept.');
  return result.jobList.filter(row => {
    const p = row.properties;
    return p && p.isNewGrad !== true && (!p.expLevel || Number(p.expLevel) === 1) && (!row.tabCategory || row.tabCategory.includes(`intern:${region}:engineering_development`));
  }).map(row => {
    const p = row.properties;
    const id = String(row.jobId || '').replace(/"/g, '');
    const description = ['Listing summary. Qualifications may be abbreviated; open the posting for full details.', p.qualifications ? `Qualifications\n${p.qualifications}` : '', p.salary && p.salary !== 'N/A' ? `Compensation: ${p.salary}` : '', Array.isArray(p.industry) && p.industry.length ? `Industry: ${p.industry.join(', ')}` : '', p.workModel ? `Work arrangement: ${p.workModel}` : ''].filter(Boolean).join('\n\n');
    return normalize({ title: p.title || '', company: p.company || '',
      url: canonicalUrl(p.applyUrl) || (/^[a-z\d-]{1,100}$/i.test(id) ? `https://jobright.ai/jobs/info/${id}` : null),
      location: p.location || (region === 'ca' ? 'Canada · location not specified' : 'United States · location not specified'),
      description, descriptionQuality: 'summary', detailRefs: [{ kind: 'jobright', externalId: id }], employmentType: 'Internship', postedAt: isoDate(row.postedAt), dateBasis: 'listing',
      remote: p.workModel === 'Remote', terms: jobTerms(`${p.title || ''} ${p.hireTime || ''}`),
      years: [...new Set((`${p.title || ''} ${p.hireTime || ''}`.match(/\b20\d{2}\b/g) || []))] });
  }).filter(j => j.url && j.title && j.company);
}
export function parseInternListPage(html) {
  const $ = load(html);
  let props;
  try { props = JSON.parse($('#__NEXT_DATA__').text()).props.pageProps; }
  catch { throw new Error('Intern List did not provide a readable public job table.'); }
  if (!Array.isArray(props.initialJobs)) throw new Error('Intern List public job table format changed.');
  const region = props.pathInfo?.country === 'ca' ? 'ca' : 'us';
  return parseInternList({ result: { total: props.initialTotal ?? props.initialJobs.length, jobList: props.initialJobs.map(row => ({ jobId: row.id, postedAt: row.postedDate, properties: row })) } }, region);
}
function unique(jobs) { return [...new Map(jobs.map(j => [j.url, j])).values()]; }
const defaultPause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pageLimit(value) { return Math.max(1, Math.min(100, Number(value) || 10)); }

export async function collectRunway({ request = requestPublicJson, pages = process.env.AGGREGATOR_PAGES, details = Number(process.env.AGGREGATOR_DETAILS || 10), pause = defaultPause } = {}) {
  const jobs = [], warnings = [], limit = pageLimit(pages), detailIds = new Map();
  let exhausted = true;
  for (const employmentType of ['INTERNSHIP', 'CO_OP']) {
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; page < limit; page++) {
      try {
        if (page || jobs.length) await pause(350);
        const data = await request(runwayUrl('jobPosting.getJobs', { filters: { employmentType, location: [] }, hasLogo: true, limit: 40, sortBy: 'datePosted', cursor }));
        const value = runwayData(data), parsed = parseRunway(data);
        jobs.push(...parsed);
        parsed.forEach(job => { if (job.id) detailIds.set(job.url, job.id); });
        const next = value.nextCursor;
        if (!next || !value.jobs.length) { cursor = null; break; }
        if (typeof next !== 'object' || typeof next.lastId !== 'string' || !isoDate(next.lastPostedAt)) throw new Error('Runway pagination format changed.');
        const marker = JSON.stringify(next);
        if (cursors.has(marker)) throw new Error('Runway repeated a page cursor; partial results were kept.');
        cursors.add(marker); cursor = next;
        if (page === limit - 1) exhausted = false;
      } catch (error) {
        if (!jobs.length) throw error;
        warnings.push(`Runway search stopped early: ${error.message}`);
        // Stop further requests after a source error instead of hammering a restricted endpoint.
        return { jobs: unique(jobs), complete: false, mode: 'public', warnings };
      }
    }
  }
  if (!exhausted) warnings.push(`Checked up to ${limit} recent pages each of internships and co-ops; older listings may remain.`);
  const result = unique(jobs);
  const recent = [...result].sort((a,b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
  for (const job of recent.slice(0, Math.max(0, Math.min(50, Number(details) || 0)))) {
    const id = detailIds.get(job.url);
    if (!id || !/^[a-z\d_-]{1,100}$/i.test(id)) continue;
    try {
      await pause(350);
      const detail = runwayData(await request(runwayUrl('flightBoard.getJobPostingById', { id })));
      const description = plainText(detail.descriptionHtml || detail.description || '');
      if (description) Object.assign(job, normalize({ ...job, description, descriptionQuality: 'full' }));
    } catch (error) { warnings.push(`Some Runway descriptions were unavailable: ${error.message}`); break; }
  }
  return { jobs: result, complete: exhausted, mode: 'public', warnings };
}

export async function collectInternList({ request = requestPublicJson, pages = process.env.AGGREGATOR_PAGES, pause = defaultPause } = {}) {
  const jobs = [], warnings = [], limit = pageLimit(pages);
  let exhausted = true;
  for (const region of ['us', 'ca']) {
    let position = 0;
    const seen = new Set();
    for (let page = 0; page < limit; page++) {
      try {
        if (page || jobs.length) await pause(350);
        const url = new URL('https://jobright.ai/swan/mini-sites/list');
        url.search = new URLSearchParams({ position: String(position), count: '50' });
        const data = await request(url.toString(), { method: 'POST', body: { category: `intern:${region}:engineering_development` } });
        const parsed = parseInternList(data, region), raw = data.result.jobList;
        const newIds = raw.map(row => row.jobId).filter(id => id && !seen.has(id));
        if (raw.length && !newIds.length) throw new Error('Intern List repeated a page; partial results were kept.');
        newIds.forEach(id => seen.add(id)); jobs.push(...parsed); position += raw.length;
        if (!raw.length || position >= Number(data.result.total)) break;
        if (page === limit - 1) exhausted = false;
      } catch (error) {
        if (!jobs.length) throw error;
        warnings.push(`Intern List search stopped early: ${error.message}`);
        return { jobs: unique(jobs), complete: false, mode: 'public', warnings };
      }
    }
  }
  if (!exhausted) warnings.push(`Checked up to ${limit} recent engineering pages per region (US and Canada); older listings may remain.`);
  return { jobs: unique(jobs), complete: exhausted, mode: 'public', warnings };
}
