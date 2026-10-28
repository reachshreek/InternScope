import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const folder = 'test-results/source-inspection';
for (const file of readdirSync(folder).filter(file => file.startsWith('runway-'))) {
  const code = readFileSync(`${folder}/${file}`, 'utf8');
  const snippets = code.match(/.{0,70}(?:value:"INTERNSHIP"|value:"internship"|label:"Internship"|employmentType:"[^"]+").{0,100}/g) || [];
  if (snippets.length) console.log(file, snippets.slice(0, 4).join('\n'));
}
const headers = { 'User-Agent': 'Internscope/1.0 (personal internship discovery)', 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
const response = await fetch('https://jobright.ai/swan/mini-sites/list?position=50&count=50', { method: 'POST', headers, body: JSON.stringify({ category: 'intern:us:engineering_development' }), signal: AbortSignal.timeout(25000) });
const body = await response.text();
if (response.headers.get('content-type')?.includes('json')) {
  const data = JSON.parse(body), result = data.result || data;
  writeFileSync(`${folder}/internlist-api.json`, JSON.stringify(data));
  console.log('Intern List paginated API', JSON.stringify({ status: response.status, keys: Object.keys(data), resultKeys: Object.keys(result), total: result.total, count: result.jobList?.length, first: result.jobList?.[0] }).slice(0, 4500));
} else console.log('Intern List API result', response.status, response.url, body.match(/<title[^>]*>(.*?)<\/title>/)?.[1]);
const list = JSON.parse(readFileSync(`${folder}/runway-api.json`, 'utf8')).result.data.json;
console.log('Runway pagination', JSON.stringify({ keys: Object.keys(list), count: list.jobs.length, nextCursor: list.nextCursor }));
const url = new URL('https://app.joinrunway.io/api/trpc/flightBoard.getJobPostingById');
url.searchParams.set('input', JSON.stringify({ json: { id: list.jobs[0].id } }));
const detailResponse = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
const detail = await detailResponse.json();
writeFileSync(`${folder}/runway-detail.json`, JSON.stringify(detail));
console.log('Runway detail', JSON.stringify({ status: detailResponse.status, data: detail }).slice(0, 5000));
