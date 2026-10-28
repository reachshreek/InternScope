import { isoDate } from './text.js';
const text = value => typeof value === 'string' ? value.trim().slice(0, 500) : typeof value?.descriptor === 'string' ? value.descriptor.trim().slice(0, 500) : '';
export function needsWorkdayMetadata(job) {
  try { return /^[a-z\d-]+\.wd\d+\.myworkdayjobs\.com$/i.test(new URL(job.url).hostname) && !job.workdayDetailsFetchedAt; }
  catch { return false; }
}
export function workdayMetadata(row, { detail = false, now = Date.now() } = {}) {
  const metadata = {};
  const locations = [...new Set([text(row.location || row.locationsText), ...(Array.isArray(row.additionalLocations) ? row.additionalLocations.map(text) : [])].filter(Boolean))];
  if (locations.length) metadata.locations = locations;
  if (text(row.timeType)) metadata.timeType = text(row.timeType);
  if (text(row.remoteType || row.workplaceType)) metadata.workplaceType = text(row.remoteType || row.workplaceType);
  const code = text(row.jobReqId) || (Array.isArray(row.bulletFields) ? row.bulletFields.map(text).find(v => /^(?:JR|R|REQ)?\d[\w-]*$/i.test(v)) : '');
  if (code) metadata.requisitionId = code;
  const posted = text(row.postedOn);
  if (posted) metadata.sourcePostedOn = posted;
  const exact = detail && /^\d{4}-\d{2}-\d{2}$/.test(row.startDate || '') ? isoDate(row.startDate) : null;
  if (exact) metadata.postedDatePrecision = 'day';
  let estimated = null;
  const days = posted.match(/^Posted\s+(\d+)\s+Days?\s+Ago$/i);
  if (days) estimated = new Date(now - Number(days[1]) * 86400000).toISOString();
  else if (/^Posted Today$/i.test(posted)) estimated = new Date(now).toISOString();
  else if (/^Posted Yesterday$/i.test(posted)) estimated = new Date(now - 86400000).toISOString();
  // "30+ days" is a lower bound, never an exact date.
  if (detail) metadata.workdayDetailsFetchedAt = new Date(now).toISOString();
  return { postingMetadata: metadata, postedAt: exact || estimated, dateBasis: exact ? 'published' : estimated ? 'estimated' : 'unknown' };
}
