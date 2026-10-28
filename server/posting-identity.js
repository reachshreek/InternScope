// Strong ATS identifiers only. Similar company/title/location text is not an identity.
export function postingIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const gh = url.searchParams.get('gh_jid');
    if (/^\d{1,20}$/.test(gh || '')) return `greenhouse:${gh}`;
    if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(url.hostname)) {
      const id = url.pathname.match(/^\/[^/]+\/jobs\/(\d+)\/?$/)?.[1]
        || (url.pathname === '/embed/job_app' ? url.searchParams.get('token') : null);
      return /^\d{1,20}$/.test(id || '') ? `greenhouse:${id}` : null;
    }
    if (/^jobs(?:\.eu)?\.lever\.co$/.test(url.hostname) || url.hostname === 'jobs.ashbyhq.com') {
      const match = url.pathname.match(/^\/([^/]+)\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\/application|\/apply)?\/?$/i);
      return match ? `${url.hostname}:${match[1].toLowerCase()}:${match[2].toLowerCase()}` : null;
    }
    if (/^[a-z\d-]+\.wd\d+\.myworkdayjobs\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split('/').filter(Boolean), at = parts.indexOf('job');
      const requisition = parts.at(-1)?.match(/_((?:JR|R)?\d+(?:-\d+)?)$/i)?.[1];
      return at > 0 && requisition ? `workday:${url.hostname}:${parts[at - 1].toLowerCase()}:${requisition.toLowerCase()}` : null;
    }
    return null;
  } catch { return null; }
}
