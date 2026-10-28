import { collectRunway, collectInternList } from '../server/aggregators.js';
for (const [name, collect] of [['Runway', collectRunway], ['Intern List', collectInternList]]) {
  try {
    const result = await collect({ pages: 2, details: 2 });
    console.log(JSON.stringify({ name, jobs: result.jobs.length, complete: result.complete, warnings: result.warnings,
      withDescriptions: result.jobs.filter(j => j.description.length > 250).length,
      first: result.jobs[0] ? { title: result.jobs[0].title, company: result.jobs[0].company, url: result.jobs[0].url, date: result.jobs[0].postedAt, dateBasis: result.jobs[0].dateBasis } : null }, null, 2));
  } catch (error) { console.log(name, error.message); process.exitCode = 1; }
}
