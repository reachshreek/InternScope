import { descriptionQuality, QUALITY_LABELS } from './quality.js';
const SKILLS = {
  Python: ['python'], JavaScript: ['javascript', 'java script'], TypeScript: ['typescript'], Java: ['java'],
  'C++': ['c++', 'cpp'], 'C#': ['c#', 'csharp'], C: ['c programming', 'embedded c'], Go: ['golang', 'go language'], Rust: ['rust'],
  SQL: ['sql', 'postgresql', 'mysql', 'sqlite'], React: ['react', 'reactjs', 'react.js'], 'Node.js': ['node.js', 'nodejs', 'node js'],
  HTML: ['html'], CSS: ['css', 'tailwind'], AWS: ['aws', 'amazon web services'], Azure: ['azure'], GCP: ['gcp', 'google cloud'],
  Docker: ['docker'], Kubernetes: ['kubernetes', 'k8s'], Git: ['git', 'github', 'gitlab'], Linux: ['linux'],
  'Machine learning': ['machine learning', 'scikit-learn', 'sklearn'], 'Deep learning': ['deep learning', 'neural networks'],
  PyTorch: ['pytorch'], TensorFlow: ['tensorflow'], Pandas: ['pandas'], NumPy: ['numpy'], R: ['r programming', 'r language', 'rstudio'],
  Excel: ['excel'], Tableau: ['tableau'], 'Power BI': ['power bi'], Statistics: ['statistics', 'statistical'],
  'Data analysis': ['data analysis', 'data analytics'], 'Data engineering': ['data engineering', 'etl', 'data pipelines'],
  Figma: ['figma'], 'UX design': ['ux', 'user experience', 'user research'], 'UI design': ['ui design', 'user interface'],
  'Product management': ['product management', 'product manager', 'product strategy'], 'Project management': ['project management'],
  Marketing: ['marketing'], SEO: ['seo', 'search engine optimization'], 'Social media': ['social media'],
  Finance: ['finance', 'financial', 'valuation'], Accounting: ['accounting'], Economics: ['economics', 'econometric'],
  SolidWorks: ['solidworks'], CAD: ['cad', 'autocad', 'fusion 360'], MATLAB: ['matlab'], Simulink: ['simulink'],
  'Electrical engineering': ['electrical engineering', 'circuit design', 'circuits'], PCB: ['pcb', 'altium', 'kicad'],
  'Embedded systems': ['embedded', 'firmware', 'microcontroller'], Verilog: ['verilog', 'systemverilog', 'vhdl'],
  Robotics: ['robotics', 'ros2', 'robot operating system'], 'Mechanical engineering': ['mechanical engineering', 'thermodynamics'],
  'Civil engineering': ['civil engineering', 'structural engineering'], Biology: ['biology', 'biological'], Chemistry: ['chemistry'],
  Research: ['research'], Writing: ['writing', 'copywriting'], Communication: ['communication', 'presentation'],
  'Customer service': ['customer service', 'customer support'], Sales: ['sales', 'business development'],
  Swift: ['swift', 'swiftui'], Kotlin: ['kotlin'], Flutter: ['flutter'], Django: ['django'], Flask: ['flask'], Spring: ['spring boot'],
  Testing: ['unit testing', 'pytest', 'jest', 'test automation'], Cybersecurity: ['cybersecurity', 'security engineering', 'penetration testing']
};
const STOP = new Set('the and for with you your our are this that from will have has into work team intern internship internships experience skills degree student students summer spring fall winter about can who all was were their they including ability strong preferred required requirements responsibilities company opportunity role position using use new related must such also more may knowledge working engineering university bachelor master development school year us an to in on of a as or be by at is it we'.split(' '));
export function tokens(text) { return String(text).toLowerCase().match(/[a-z][a-z0-9+#.\-]{1,}/g)?.filter(t => !STOP.has(t)) ?? []; }
const patterns = new Map();
function includes(text, phrase) {
  if (patterns.has(phrase)) return patterns.get(phrase).test(text);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i');
  if (patterns.size >= 512) patterns.clear();
  patterns.set(phrase, pattern);
  return pattern.test(text);
}
export function extractSkills(text) { return Object.entries(SKILLS).filter(([, aliases]) => aliases.some(p => includes(text, p))).map(([name]) => name); }
export function split(value) { return String(value || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean); }
export function jobTerms(text) { return [...new Set((String(text).match(/\b(summer|spring(?!\s+boot)|fall|autumn|winter)\b/gi) || []).map(t => t.toLowerCase().replace('autumn', 'fall')))]; }
let prepared;
function prepare(profile) {
  const key = JSON.stringify([profile.resume, profile.roles, profile.keywords]);
  if (prepared?.key === key) return prepared;
  prepared = { key, have: new Set(extractSkills(profile.resume || '')), resumeTokens: new Set(tokens(profile.resume || '')), roles: split(profile.roles), keywordTerms: split(profile.keywords) };
  return prepared;
}
// Cache by posting content, not status: applying/hiding never changes a match.
export function createMatchCache({ limit = 20000 } = {}) {
  let profileKey; const entries = new Map();
  return (job, profile) => {
    const key = JSON.stringify([profile.resume, profile.roles, profile.keywords]);
    if (key !== profileKey) { entries.clear(); profileKey = key; }
    const quality = descriptionQuality(job), cached = entries.get(job.id);
    if (cached && cached.title === job.title && cached.description === job.description && cached.quality === quality) return cached.match;
    const match = scoreJob(job, profile);
    if (entries.size >= limit) entries.delete(entries.keys().next().value);
    entries.set(job.id, { title: job.title, description: job.description, quality, match });
    return match;
  };
}
export function scoreJob(job, profile) {
  const quality = descriptionQuality(job), qualityLabel = QUALITY_LABELS[quality];
  if (!profile.resume?.trim()) return { score: null, matched: [], missing: [], reasons: ['Add your resume to calculate a match.'], confidence: 'none', quality, qualityLabel, provisional: quality !== 'full' };
  const { have, resumeTokens, roles, keywordTerms } = prepare(profile);
  const text = `${job.title} ${job.description}`;
  const required = extractSkills(text);
  const matched = required.filter(s => have.has(s)), missing = required.filter(s => !have.has(s));
  const jobTokens = [...new Set(tokens(text))];
  const overlap = jobTokens.filter(t => resumeTokens.has(t));
  const lexical = Math.min(1, overlap.length / Math.max(6, Math.min(jobTokens.length, 55)));
  const skill = required.length ? matched.length / required.length : lexical;
  const titleMatch = roles.length ? roles.some(r => tokens(r).some(t => includes(job.title, t))) : null;
  const keywordHits = keywordTerms.filter(k => includes(text, k));
  let total = (skill * .65 + lexical * .35) * 100;
  if (titleMatch !== null) total = total * .85 + (titleMatch ? 15 : 0);
  if (keywordTerms.length) total = total * .9 + (keywordHits.length / keywordTerms.length) * 10;
  const reasons = [];
  if (matched.length) reasons.push(`${matched.length} of ${required.length} recognized skills align with your resume`);
  if (titleMatch) reasons.push('Matches a preferred role');
  if (keywordHits.length) reasons.push(`Includes ${keywordHits.join(', ')}`);
  if (!required.length) reasons.push('Based on shared resume and posting terms');
  const limited = quality !== 'full';
  if (limited) reasons.push('Limited posting details; match may change with a full description');
  return { score: Math.round(Math.max(0, Math.min(99, total))), matched, missing, reasons, confidence: limited ? 'limited' : 'standard', quality, qualityLabel, provisional: limited };
}
export function fits(job, profile) {
  const text = `${job.title} ${job.description}`, locations = split(profile.locations);
  if (locations.length && !locations.some(l => includes(job.location, l)) && !(profile.includeRemote && job.remote)) return false;
  if (profile.remoteOnly && !job.remote) return false;
  if (profile.season && !job.terms.includes(profile.season) && !(profile.includeUnknown && !job.terms.length)) return false;
  if (profile.year) {
    const years = job.years || job.title.match(/\b20\d{2}\b/g) || [];
    if (!years.includes(String(profile.year)) && !(profile.includeUnknown && !years.length)) return false;
  }
  if (profile.strictRoles && split(profile.roles).length && !split(profile.roles).some(r => tokens(r).some(t => includes(job.title, t)))) return false;
  if (split(profile.exclude).some(k => includes(text, k))) return false;
  return true;
}
export function priority(job, score, now = Date.now()) {
  const age = Math.max(0, (now - new Date(job.postedAt || job.firstSeen).getTime()) / 86400000);
  const freshness = 100 * Math.exp(-age / 10);
  return (score ?? 50) * .72 + freshness * .28;
}
