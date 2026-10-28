export const QUALITY_LABELS = { title: 'Title only', summary: 'Summary', full: 'Full description' };
export const qualityRank = value => ({ title: 0, summary: 1, full: 2 }[value] ?? 0);
export function descriptionQuality(job) {
  const text = String(job.description || '').trim();
  if (!text) return 'title';
  if (job.descriptionQuality === 'summary' || text.startsWith('Listing summary.')) return 'summary';
  return text.length >= 250 ? 'full' : 'summary';
}
const clean = value => String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim().replace(/\s+/g, ' ');
export function positionKey(job) {
  const company = clean(job.company).replace(/\s+(?:inc|incorporated|llc|ltd|limited|corp|corporation)$/, '');
  const title = clean(job.title), location = clean(job.location);
  if (!company || !title || !location || /^(not specified|remote|multiple locations|united states|canada|no location provided)$/.test(location)) return null;
  // Exact normalized company/title/location only. No fuzzy role or location matching.
  return `${company}|${title}|${location}`;
}
export function compatiblePosition(a, b) {
  for (const key of ['years', 'terms']) {
    const left = a[key] || [], right = b[key] || [];
    if (left.length && right.length && !left.some(value => right.includes(value))) return false;
  }
  const left = Date.parse(a.postedAt || a.firstSeen), right = Date.parse(b.postedAt || b.firstSeen);
  return !Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) <= 31 * 86400000;
}
