import { load } from 'cheerio';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('test-results/source-inspection', { recursive: true });
for (const [name, url] of [['runwayapp', 'https://app.joinrunway.io/explore']]) {
  try {
    const response = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Internscope/1.0 (personal internship discovery)', Accept: 'text/html' } });
    const html = await response.text(), $ = load(html);
    writeFileSync(`test-results/source-inspection/${name}.html`, html);
    const scripts = $('script[src]').map((i, el) => $(el).attr('src')).get();
    const inline = $('script:not([src])').map((i, el) => ({ id: $(el).attr('id'), type: $(el).attr('type'), size: $(el).text().length })).get();
    $('script,style,svg').remove();
    console.log(JSON.stringify({ name, status: response.status, url: response.url, length: html.length, title: $('title').text(), text: $('body').text().replace(/\s+/g, ' ').slice(0, 4000), scripts, inline, links: $('a[href]').map((i, el) => ({ label: $(el).text().trim().slice(0, 70), href: $(el).attr('href') })).get().slice(0, 30) }, null, 2));
  } catch (error) { console.log(name, error.message); }
}
{
  const { readFileSync } = await import('node:fs');
  const $ = load(readFileSync('test-results/source-inspection/internlist.html', 'utf8'));
  const code = $('script:not([src])').map((i, el) => $(el).text()).get().filter(text => text.includes('axios') || text.includes('fetch(')).join('\n');
  writeFileSync('test-results/source-inspection/internlist-client.txt', code);
  console.log('Intern List client data access:', code.slice(0, 17000));
}
