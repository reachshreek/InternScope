import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import { plainText, canonicalUrl, isoDate } from './text.js';
import { runwayUrl } from './aggregators.js';
import { boardFromUrl, boardApi } from './boards.js';
import { workdayMetadata } from './workday-metadata.js';

export class DetailError extends Error {
  constructor(message, { status, host, retryAfter, permanent = false } = {}) { super(message); Object.assign(this, { status, host, retryAfter, permanent }); }
}
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
  }
  // Restrict IPv6 to global unicast; reject mapped/compatible IPv4 and local ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^(?:2001:(?:db8|0|10|20):|2002:)/i.test(address);
}
export async function validatePublicUrl(value, resolve = lookup) {
  let url; try { url = new URL(value); } catch { throw new DetailError('Invalid posting URL.', { permanent: true }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname.includes('.') || isIP(url.hostname.replace(/[\[\]]/g, '')) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)) throw new DetailError('Only public HTTPS posting URLs can be fetched.', { permanent: true });
  let timer;
  const addresses = await Promise.race([
    resolve(url.hostname, { all: true, verbatim: true }),
    new Promise((done, reject) => { timer = setTimeout(() => reject(new DetailError('Posting DNS lookup timed out.', { host: url.hostname })), 10000); })
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new DetailError('Posting hostname does not resolve exclusively to public addresses.', { permanent: true });
  return { url, addresses };
}
export async function fetchPublicPage(value, { resolve = lookup, maxBytes = 3_000_000, timeout = 18000, beforeRequest = async () => {}, redirects = 0 } = {}) {
  if (redirects > 4) throw new DetailError('Too many posting redirects.', { permanent: true });
  const { url, addresses } = await validatePublicUrl(value, resolve);
  await beforeRequest(url.hostname);
  const response = await new Promise((done, reject) => {
    const request = https.request(url, {
      method: 'GET', agent: false, headers: { Accept: 'text/html,application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'Internscope/1.0 (public job description reader)' },
      // Pin the already-validated DNS answer so a DNS rebind cannot target a private host.
      lookup(hostname, options, callback) { const first = addresses[0]; if (options.all) callback(null, addresses); else callback(null, first.address, first.family); }
    }, res => {
      const chunks = []; let bytes = 0;
      if (Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); reject(new DetailError('Posting exceeds the response size limit.', { host: url.hostname, permanent: true })); return; }
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(new DetailError('Posting exceeds the response size limit.', { host: url.hostname, permanent: true })); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url: url.toString() }));
      res.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(new DetailError('Posting request timed out.', { host: url.hostname })), timeout);
    request.on('close', () => clearTimeout(deadline)); request.on('error', reject); request.end();
  });
  if ([301,302,303,307,308].includes(response.status) && response.headers.location) {
    return fetchPublicPage(new URL(response.headers.location, url).toString(), { resolve, maxBytes, timeout, beforeRequest, redirects: redirects + 1 });
  }
  if (response.status >= 400) {
    const retry = response.headers['retry-after'];
    const retryAfter = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : null;
    throw new DetailError(`Posting returned HTTP ${response.status}.`, { status: response.status, host: url.hostname, retryAfter, permanent: [404,410].includes(response.status) });
  }
  if (/<title[^>]*>[^<]*(?:security check|just a moment|access denied|sign in)/i.test(response.body)) throw new DetailError('The posting requires a login or security check.', { host: url.hostname, status: 403 });
  return response;
}
function descriptionResult(text, url, method) {
  const description = plainText(text || '');
  return description.length >= 250 ? { description, descriptionQuality: 'full', url, method } : null;
}
export function extractPublicDescription(html, job, url) {
  const $ = load(html), structured = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().includes('JobPosting')) structured.push(value);
    for (const key of ['@graph','item','itemListElement']) if (value[key]) visit(value[key]);
  };
  $('script[type="application/ld+json"]').each((i, element) => { try { visit(JSON.parse($(element).text())); } catch {} });
  const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const matching = structured.filter(item => norm(item.title) === norm(job.title));
  // Never borrow a description from a different role on a list/search page.
  if (matching.length === 1) {
    const result = descriptionResult(matching[0].description, url, 'job-posting-schema'); if (result) return result;
  }
  if (new URL(url).hostname.endsWith('jobright.ai')) {
    try {
      const props = JSON.parse($('#__NEXT_DATA__').text())?.props?.pageProps;
      const found = [];
      const walk = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 7) return;
        if (norm(node.title || node.jobTitle) === norm(job.title)) {
          const result = descriptionResult(node.descriptionHtml || node.description || node.jobDescription, url, 'public-job-data'); if (result) found.push(result);
        }
        Object.values(node).forEach(value => { if (value && typeof value === 'object') walk(value, depth + 1); });
      };
      walk(props); if (found.length === 1) return found[0];
    } catch {}
  }
  const host = new URL(url).hostname;
  const selector = host === 'www.linkedin.com' ? '.show-more-less-html__markup' : /greenhouse\.io$/.test(host) ? '#content, .job__description, .job-description' : /^jobs(?:\.eu)?\.lever\.co$/.test(host) ? '.section-wrapper.page-full-width, .posting-page .content' : /\.myworkdayjobs\.com$/.test(host) ? '[data-automation-id="jobPostingDescription"]' : '[itemprop="description"], [data-testid="job-description"], #jobDescriptionText, #job-description, .job-description';
  const section = $(selector).first();
  if (section.length) {
    const headings = $('h1').map((i, element) => $(element).text()).get();
    if (host === 'www.linkedin.com' || headings.some(title => norm(title) === norm(job.title))) return descriptionResult(section.html(), url, 'public-posting-section');
  }
  return null;
}
export async function fetchJobDescription(job, refs = [], { request = fetchPublicPage, beforeRequest } = {}) {
  const fetchPage = url => request(url, { beforeRequest });
  const url = new URL(job.url), parts = url.pathname.split('/').filter(Boolean);
  let api;
  const board = boardFromUrl(job.url);
  const gh = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (board?.kind === 'greenhouse' && gh) api = `${boardApi(board).url}/${gh[2]}`;
  if (board?.kind === 'lever' && parts.length >= 2) api = `${boardApi(board).url}/${encodeURIComponent(parts[1])}`;
  if (api) {
    const page = await fetchPage(api), data = JSON.parse(page.body);
    const text = data.content || [data.descriptionPlain || data.description, ...(data.lists || []).map(list => `${list.text}\n${plainText(list.content)}`), data.additionalPlain].filter(Boolean).join('\n\n');
    const result = descriptionResult(text, job.url, 'employer-api');
    if (result) {
      const postedAt = isoDate(board.kind === 'greenhouse' ? data.first_published : data.createdAt);
      return { ...result, ...(postedAt ? { postedAt, dateBasis: 'published' } : {}) };
    }
  }
  if (url.hostname === 'jobs.ashbyhq.com' && parts.length >= 2) {
    const page = await fetchPage(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parts[0])}`), data = JSON.parse(page.body);
    const row = data.jobs?.find(item => canonicalUrl(item.jobUrl) === canonicalUrl(job.url));
    const result = row && descriptionResult(row.descriptionPlain || row.descriptionHtml, row.jobUrl, 'employer-api'); if (result) return result;
  }
  const workdayAt = parts.indexOf('job');
  if (/^[a-z\d-]+\.wd\d+\.myworkdayjobs\.com$/i.test(url.hostname) && workdayAt > 0 && parts.length > workdayAt + 1) {
    const page = await fetchPage(`${url.origin}/wday/cxs/${url.hostname.split('.')[0]}/${encodeURIComponent(parts[workdayAt-1])}/job/${parts.slice(workdayAt+1).join('/')}`);
    const data = JSON.parse(page.body), result = descriptionResult(data.jobPostingInfo?.jobDescription, job.url, 'employer-workday-api');
    if (result) return { ...result, ...workdayMetadata(data.jobPostingInfo, { detail: true }) };
  }
  const runway = refs.find(ref => ref.kind === 'runway' && /^[a-z\d_-]{1,100}$/i.test(ref.externalId));
  if (runway) {
    const page = await fetchPage(runwayUrl('flightBoard.getJobPostingById', { id: runway.externalId })), data = JSON.parse(page.body);
    if (data.error) throw new DetailError('Runway description access is unavailable.', { status: 403, host: 'app.joinrunway.io' });
    const result = descriptionResult(data.result?.data?.json?.descriptionHtml, job.url, 'runway-public-details'); if (result) return result;
  }
  if (url.hostname === 'www.linkedin.com') {
    const id = url.pathname.match(/(?:-|\/)(\d{6,})\/?$/)?.[1];
    if (id) { const page = await fetchPage(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`); const result = extractPublicDescription(page.body, job, page.url); if (result) return result; }
  }
  const page = await fetchPage(job.url), result = extractPublicDescription(page.body, job, page.url);
  if (result) return result;
  throw new DetailError('No full public description was found. The posting may require JavaScript, a login, or an unsupported format.', { host: url.hostname, permanent: true });
}
