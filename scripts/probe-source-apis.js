import { load } from 'cheerio';
import { readFileSync, writeFileSync } from 'node:fs';
const folder = 'test-results/source-inspection';
const headers = { 'User-Agent': 'Internscope/1.0 (personal internship discovery)', Accept: 'application/json' };
const url = new URL('https://app.joinrunway.io/api/trpc/jobPosting.getJobs');
url.searchParams.set('input', JSON.stringify({ json: { filters: { search: 'intern', location: [] }, hasLogo: true, limit: 40, sortBy: 'datePosted', cursor: null } }));
const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
const body = await response.text();
writeFileSync(`${folder}/runway-api.json`, body);
let data; try { data = JSON.parse(body); } catch { data = body.slice(0, 300); }
console.log('Runway public API', response.status);

const $ = load(readFileSync(`${folder}/internlist-jobs.html`, 'utf8'));
const scripts = $('script[src]').map((i, el) => $(el).attr('src')).get().filter(src => !/polyfills|webpack|framework|\/main-|Manifest/.test(src));
let index = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (index < scripts.length) {
    const path = scripts[index++];
    const code = await (await fetch(path, { headers, signal: AbortSignal.timeout(25000) })).text();
    const at = code.search(/(?:\{|,)6922:/);
    if (at >= 0) {
      writeFileSync(`${folder}/internlist-api-client.txt`, code);
      console.log('Intern List API function', code.slice(at, at + 500));
    }
    const configAt = code.search(/(?:\{|,)93740(?:\:|\()/);
    if (configAt >= 0) {
      writeFileSync(`${folder}/internlist-config-client.txt`, code);
      console.log('Intern List public API configuration', code.slice(configAt, configAt + 3500));
    }
    if (path.includes('/_app')) {
      writeFileSync(`${folder}/internlist-app-client.txt`, code);
      console.log('App configuration hints', (code.match(/.{0,80}(?:93740|QU:|QU=|baseURL:|api\.jobright).{0,140}/g) || []).slice(0, 12));
    }
  }
}));
