// Only these public ATS hosts can become source request targets.
const SLUG = /^[a-zA-Z0-9_-]{1,100}$/;
const ASHBY_SLUG = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/;
const WORKDAY_HOST = /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i;
export const BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'workday'];

export function boardFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    let kind, token;
    if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)) {
      kind = 'greenhouse';
      token = parts[0] === 'embed' ? url.searchParams.get('for') : parts[0];
      if (!SLUG.test(token || '') || ['embed', 'jobs', 'v1'].includes(token)) return null;
      if (url.hostname.includes('.eu.')) token += '@eu';
    } else if (/^jobs(?:\.eu)?\.lever\.co$/.test(url.hostname)) {
      kind = 'lever'; token = parts[0];
      if (!SLUG.test(token || '')) return null;
      if (url.hostname.includes('.eu.')) token += '@eu';
    } else if (url.hostname === 'jobs.ashbyhq.com') {
      kind = 'ashby'; token = parts[0];
      if (!ASHBY_SLUG.test(token || '') || token === '.' || token === '..') return null;
    } else if (WORKDAY_HOST.test(url.hostname)) {
      kind = 'workday';
      const site = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '') && parts[1] ? parts[1] : parts[0];
      if (!SLUG.test(site || '') || ['wday', 'job'].includes(site.toLowerCase())) return null;
      token = `${url.hostname}/${site}`;
    } else return null;
    return { kind, token };
  } catch { return null; }
}

export function normalizeBoardToken(kind, value) {
  if (typeof value !== 'string' || !BOARD_KINDS.includes(kind)) return null;
  const token = value.trim();
  if (token.startsWith('https://')) {
    const board = boardFromUrl(token);
    return board?.kind === kind ? board.token : null;
  }
  if (kind === 'workday') {
    const [host, site, extra] = token.split('/');
    return !extra && WORKDAY_HOST.test(host) && SLUG.test(site || '') ? `${host.toLowerCase()}/${site}` : null;
  }
  if (kind === 'ashby') return ASHBY_SLUG.test(token) && token !== '.' && token !== '..' ? token : null;
  return /^[a-zA-Z0-9_-]{1,100}(?:@eu)?$/.test(token) ? token : null;
}

export function boardApi(source) {
  const token = normalizeBoardToken(source.kind, source.token);
  if (!token) throw new Error('Invalid company board identifier.');
  if (source.kind === 'workday') {
    const [host, site] = token.split('/');
    const tenant = host.split('.')[0];
    return { host, site, tenant, url: `https://${host}/wday/cxs/${tenant}/${encodeURIComponent(site)}/jobs` };
  }
  const [slug, region] = token.split('@');
  const encoded = encodeURIComponent(slug);
  return { url: source.kind === 'greenhouse' ? `https://boards-api${region === 'eu' ? '.eu' : ''}.greenhouse.io/v1/boards/${encoded}/jobs`
    : source.kind === 'lever' ? `https://api${region === 'eu' ? '.eu' : ''}.lever.co/v0/postings/${encoded}`
    : `https://api.ashbyhq.com/posting-api/job-board/${encoded}` };
}
