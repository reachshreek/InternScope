import { boardApi } from './boards.js';
import { normalize, isInternship, fetchJson } from './providers.js';
import { workdayMetadata } from './workday-metadata.js';

const INTERN = /\bintern(?:ship)?s?\b|\bco[ -]?op\b/i;

function listingData(data) {
  if (!data || data.errorCode || !Array.isArray(data.jobPostings) || !Number.isInteger(data.total) || data.total < 0) {
    throw new Error('Workday returned an invalid listing response. Existing results were kept.');
  }
  return data;
}

export function parseWorkday(data, source, { internshipFacet = false } = {}) {
  const { host, site } = boardApi(source);
  return listingData(data).jobPostings.flatMap(row => {
    // Build links only from Workday's relative posting paths, never arbitrary URLs.
    if (typeof row.title !== 'string' || !row.title.trim() || typeof row.externalPath !== 'string' || !/^\/job\/[^?#\\]+$/.test(row.externalPath)) return [];
    const url = new URL(`/${encodeURIComponent(site)}${row.externalPath}`, `https://${host}`);
    if (!url.pathname.startsWith(`/${encodeURIComponent(site)}/job/`)) return [];
    let location = typeof row.locationsText === 'string' ? row.locationsText : '';
    if (/^\d+ locations?$/i.test(location)) {
      const primary = row.externalPath.split('/')[2]?.replace(/-/g, ' ');
      if (primary) location = `${primary} · ${location}`;
    }
    const job = { title: row.title.trim(), company: source.name, url: url.toString(), location,
      employmentType: internshipFacet ? 'Internship' : '', description: '', descriptionQuality: 'title',
      ...workdayMetadata(row) };
    return isInternship(job) ? [normalize(job)] : [];
  });
}

// Inspired by Vigil's Workday workerSubType discovery; see THIRD_PARTY_NOTICES.md.
export async function collectWorkday(source, { request = (url, body) => fetchJson(url, (target, options) => fetch(target, {
  ...options, method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
})), pages = Number(process.env.WORKDAY_PAGES || 100), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { url } = boardApi(source);
  const maxPages = Math.max(1, Math.min(500, Math.floor(Number(pages) || 100)));
  const probe = listingData(await request(url, { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }));
  const ids = [...new Set((probe.facets || []).filter(facet => facet.facetParameter === 'workerSubType')
    .flatMap(facet => (facet.values || []).filter(value => INTERN.test(value.descriptor || '') && typeof value.id === 'string').map(value => value.id)))];
  const queries = ids.length ? [''] : ['intern', 'co-op'];
  const jobs = new Map(), warnings = [];
  let complete = ids.length > 0, successfulPages = 0;
  for (const searchText of queries) {
    let offset = 0, total;
    const seenPages = new Set();
    for (let page = 0; page < maxPages; page++) {
      try {
        await pause(300);
        const data = listingData(await request(url, { appliedFacets: ids.length ? { workerSubType: ids } : {}, limit: 20, offset, searchText }));
        // Later Workday pages can report only the window's size as "total".
        // Keep the first page's catalog total, as Vigil does, to avoid early exits.
        total ??= data.total;
        successfulPages++;
        const fingerprint = JSON.stringify(data.jobPostings.map(row => row.externalPath));
        if (data.jobPostings.length && seenPages.has(fingerprint)) {
          warnings.push('Workday repeated a listing page; earlier results were retained.'); complete = false; break;
        }
        seenPages.add(fingerprint);
        for (const job of parseWorkday(data, source, { internshipFacet: ids.length > 0 })) jobs.set(job.url, job);
        offset += data.jobPostings.length;
        if (offset >= total) break;
        if (!data.jobPostings.length) {
          warnings.push('Workday ended before its reported total; earlier results were retained.'); complete = false; break;
        }
        if (page === maxPages - 1) {
          warnings.push('Workday reached the page limit; older results were retained.'); complete = false;
        }
      } catch (error) {
        if (!successfulPages) throw error;
        return { jobs: [...jobs.values()], complete: false, mode: 'public', warnings: [...warnings, `Workday returned partial results: ${String(error.message).slice(0, 400)}`] };
      }
    }
  }
  if (!ids.length) warnings.push('No internship category was published; used internship/co-op searches with partial coverage.');
  return { jobs: [...jobs.values()], complete, mode: 'public', warnings };
}
