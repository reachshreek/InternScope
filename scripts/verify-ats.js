// Live, read-only probes. Does not open the user's database or submit applications.
import { collectWorkday } from '../server/workday.js';
import { collectSource } from '../server/providers.js';
import { WORKDAY_SOURCES } from '../server/db.js';
import { fetchJobDescription } from '../server/detail-fetch.js';
import { requestPublicJson } from '../server/aggregators.js';

const results = await Promise.allSettled(WORKDAY_SOURCES.map(async ([kind, name, token]) => {
  const pageTotals = [];
  const result = await collectWorkday({ kind, name, token }, { pages: 2, request: async (url, body) => {
    const data = await requestPublicJson(url, { method: 'POST', body });
    pageTotals.push({ offset: body.offset, limit: body.limit, total: data.total });
    return data;
  } });
  const first = result.jobs[0];
  let description;
  if (name === 'NVIDIA' && first) {
    try { const detail = await fetchJobDescription(first); description = { quality: detail.descriptionQuality, method: detail.method, characters: detail.description.length }; }
    catch (error) { description = { error: error.message }; }
  }
  return { name, jobs: result.jobs.length, complete: result.complete, warnings: result.warnings, pageTotals,
    first: first && { title: first.title, location: first.location, url: first.url, dateBasis: first.dateBasis }, description };
}));
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  console.log(JSON.stringify(result.status === 'fulfilled' ? result.value : { name: WORKDAY_SOURCES[i][1], error: result.reason.message }));
}
try {
  const jobs = await collectSource({ kind: 'lever', name: 'Cirrus Logic', token: 'cirrus@eu' });
  console.log(JSON.stringify({ name: 'Cirrus Logic (Lever EU)', jobs: jobs.length, first: jobs[0] && { title: jobs[0].title, url: jobs[0].url } }));
} catch (error) { console.log(JSON.stringify({ name: 'Cirrus Logic (Lever EU)', error: error.message })); }
