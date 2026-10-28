import { load } from 'cheerio';
import { readFileSync, writeFileSync } from 'node:fs';

const headers = { 'User-Agent': 'Internscope/1.0 (personal internship discovery)' };
const read = async url => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000), cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};
const intern = load(readFileSync('test-results/source-inspection/internlist.html', 'utf8'));
const targets = intern('[short-link="eng"]').map((i, el) => ({ name: intern(el).text(), path: intern(el).attr('data-job-path'), link: intern(el).attr('airtable-link') })).get();
console.log('Intern List engineering targets', JSON.stringify(targets));
for (const target of targets.filter(t => t.path).slice(0, 1)) {
  const url = `https://jobright.ai/minisites-jobs/intern/${target.path.replace(/^\//, '')}?embed=true`;
  const html = await read(url), $ = load(html);
  writeFileSync('test-results/source-inspection/internlist-jobs.html', html);
  const scripts = $('script[src]').map((i,el) => $(el).attr('src')).get();
  const data = $('script#__NEXT_DATA__').text();
  console.log('Intern List embedded data', JSON.stringify({ url, title: $('title').text(), size: html.length, scripts, data: data ? JSON.parse(data) : null }).slice(0, 18000));
}
const runway = load(readFileSync('test-results/source-inspection/runwayapp.html', 'utf8'));
const urls = runway('script[src]').map((i, el) => runway(el).attr('src')).get().filter(u => !/polyfills|webpack|main-app|25f6dec5|9177-a45/.test(u));
let index = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (index < urls.length) {
    const path = urls[index++];
    try {
      const code = await read(new URL(path, 'https://app.joinrunway.io'));
      const file = path.split('/').pop();
      writeFileSync(`test-results/source-inspection/runway-${file}.txt`, code);
      const endpoints = [...new Set(code.match(/\/(?:api|v1|v2)\/[a-zA-Z0-9_\-/.]+/g) || [])];
      const domains = [...new Set((code.match(/https?:\/\/[^\s"'`<>\\]+/g) || []).map(url => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; } }).filter(Boolean))];
      if (endpoints.length || domains.some(d => /runway|supabase/.test(d))) console.log(JSON.stringify({ file, size: code.length, endpoints, domains: domains.filter(d => /runway|supabase/.test(d)) }));
    } catch (error) { console.log('Bundle unavailable', path.split('/').pop(), error.message); }
  }
}));
