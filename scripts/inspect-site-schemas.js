import { load } from 'cheerio';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const folder = 'test-results/source-inspection';
const $ = load(readFileSync(`${folder}/internlist-jobs.html`, 'utf8'));
const data = JSON.parse($('#__NEXT_DATA__').text());
const props = data.props.pageProps;
console.log('Intern List props', JSON.stringify({ keys: Object.keys(props), jobCount: props.initialJobs?.length, other: Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'initialJobs')) }).slice(0, 3500));
for (const file of readdirSync(folder).filter(file => /^runway-page-/.test(file))) {
  const code = readFileSync(`${folder}/${file}`, 'utf8');
  const at = code.indexOf('jobPosting.getJobs.useInfiniteQuery');
  if (at >= 0) console.log('Runway search arguments', code.slice(at - 3300, at + 1500));
}
const internCode = readFileSync(`${folder}/internlist-job-client.txt`, 'utf8');
console.log('Intern List client setup', internCode.slice(0, 8000));
const at = internCode.indexOf('initialJobs');
console.log('Intern List query arguments', internCode.slice(at - 1000, at + 7500));
if (process.argv.includes('--fetch')) {
  const path = $('script[src]').map((i, el) => $(el).attr('src')).get().find(src => src.includes('minisites-jobs'));
  const response = await fetch(path, { headers: { 'User-Agent': 'Internscope/1.0 (personal internship discovery)' }, signal: AbortSignal.timeout(25000) });
  const code = await response.text();
  writeFileSync(`${folder}/internlist-job-client.txt`, code);
  console.log('Intern List API paths', [...new Set(code.match(/\/api\/[a-zA-Z0-9_\-/.]+/g) || [])]);
  console.log('Intern List fetch logic', (code.match(/.{0,170}(?:initialJobs|pageSize|pageNum|cursor|\.post\(|\.get\(|fetch\(|loadMore).{0,240}/g) || []).slice(0, 28).join('\n'));
}
