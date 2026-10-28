import { DatabaseSync } from 'node:sqlite';
import { fetchPublicPage, extractPublicDescription } from '../server/detail-fetch.js';
const db = new DatabaseSync('./data/internscope.sqlite', { readOnly: true });
const rows = [...db.prepare("SELECT title,company,url FROM jobs WHERE url LIKE '%myworkdayjobs.com/%' AND description='' LIMIT 2").all(), ...db.prepare("SELECT title,company,url FROM jobs WHERE url LIKE 'https://jobright.ai/jobs/info/%' LIMIT 2").all()];
db.close();
for (const job of rows) {
  try {
    const url = new URL(job.url), parts = url.pathname.split('/').filter(Boolean), at = parts.indexOf('job');
    if (url.hostname.endsWith('.myworkdayjobs.com') && at > 0) {
      const api = `${url.origin}/wday/cxs/${url.hostname.split('.')[0]}/${parts[at-1]}/job/${parts.slice(at+1).join('/')}`;
      const page = await fetchPublicPage(api), data = JSON.parse(page.body);
      console.log(JSON.stringify({ host: url.hostname, apiStatus: page.status, keys: Object.keys(data), title: data.jobPostingInfo?.title, descriptionLength: data.jobPostingInfo?.jobDescription?.length }));
    } else {
      const page = await fetchPublicPage(job.url), result = extractPublicDescription(page.body, job, page.url);
      console.log(JSON.stringify({ host: url.hostname, status: page.status, descriptionLength: result?.description?.length || 0, method: result?.method }));
    }
  } catch (error) { console.log(JSON.stringify({ host: new URL(job.url).hostname, error: error.message })); }
}
