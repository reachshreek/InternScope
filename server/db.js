import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalUrl } from './text.js';
import { descriptionQuality } from './quality.js';
import { BOARD_KINDS, normalizeBoardToken } from './boards.js';
import { postingIdentity } from './posting-identity.js';

export const DEFAULT_PROFILE = { resume: '', resumeName: '', roles: '', keywords: '', locations: '', season: '', year: '', includeRemote: true, remoteOnly: false, includeUnknown: true, strictRoles: false, exclude: '' };
export const DEFAULT_SOURCES = [
  ['community', 'Simplify & Pitt CSC', 'Summer2027-Internships'],
  ['greenhouse', 'Stripe', 'stripe'], ['greenhouse', 'Cloudflare', 'cloudflare'],
  ['greenhouse', 'Figma', 'figma'], ['greenhouse', 'SpaceX', 'spacex'],
  ['greenhouse', 'Anduril', 'andurilindustries'], ['greenhouse', 'Duolingo', 'duolingo'],
  ['greenhouse', 'Roblox', 'roblox'], ['greenhouse', 'Databricks', 'databricks'],
  ['lever', 'Palantir', 'palantir'], ['lever', 'Zoox', 'zoox'],
  ['ashby', 'Ramp', 'ramp'], ['ashby', 'Notion', 'notion']
];
export const PLATFORM_SOURCES = [['linkedin', 'LinkedIn', 'internships'], ['indeed', 'Indeed', 'internships'], ['ziprecruiter', 'ZipRecruiter', 'internships']];
export const AGGREGATOR_SOURCES = [['runway', 'Runway', 'internships'], ['internlist', 'Intern List · Engineering', 'eng']];
export const WORKDAY_SOURCES = [
  ['workday', 'NVIDIA', 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'],
  ['workday', 'Micron', 'micron.wd1.myworkdayjobs.com/External'],
  ['workday', 'Analog Devices', 'analogdevices.wd1.myworkdayjobs.com/External'],
  ['workday', 'KLA', 'kla.wd1.myworkdayjobs.com/Search']
];
function mapJob(row) {
  return { ...JSON.parse(row.posting_metadata || '{}'), id: row.id, url: row.url, title: row.title, company: row.company, location: row.location, description: row.description,
    postedAt: row.posted_at, dateBasis: row.date_basis, terms: JSON.parse(row.terms), years: JSON.parse(row.years), remote: !!row.remote,
    firstSeen: row.first_seen, lastSeen: row.last_seen, status: row.status, appliedAt: row.applied_at, note: row.note || '', active: !!row.active,
    sourceNames: row.source_names, platforms: (row.source_kinds || '').split(',').filter(Boolean), descriptionQuality: row.description_quality,
    descriptionUrl: row.description_url, descriptionFetchedAt: row.description_fetched_at, descriptionMethod: row.description_method };
}

export function openStore(directory = process.env.DATA_DIR || './data') {
  mkdirSync(resolve(directory), { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'internscope.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, token TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_success TEXT, last_error TEXT, count INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,token));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, posted_at TEXT, date_basis TEXT NOT NULL, terms TEXT NOT NULL, years TEXT NOT NULL, remote INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_sources(job_id TEXT REFERENCES jobs(id), source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(job_id,source_id));
    CREATE TABLE IF NOT EXISTS applications(job_id TEXT PRIMARY KEY REFERENCES jobs(id), status TEXT NOT NULL, applied_at TEXT, note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS refresh_runs(id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, found INTEGER DEFAULT 0, errors TEXT NOT NULL DEFAULT '[]');`);
  const sourceColumns = new Set(db.prepare('PRAGMA table_info(sources)').all().map(c => c.name));
  for (const [column, type] of [['origin', "TEXT NOT NULL DEFAULT 'manual'"], ['last_attempt', 'TEXT'], ['last_warning', 'TEXT'], ['last_mode', 'TEXT']]) {
    if (!sourceColumns.has(column)) db.exec(`ALTER TABLE sources ADD COLUMN ${column} ${type}`);
  }
  if (!db.prepare('PRAGMA table_info(job_sources)').all().some(c => c.name === 'last_seen')) {
    db.exec('ALTER TABLE job_sources ADD COLUMN last_seen TEXT');
    db.exec('UPDATE job_sources SET last_seen=(SELECT last_seen FROM jobs WHERE jobs.id=job_sources.job_id)');
  }
  if (!db.prepare('PRAGMA table_info(job_sources)').all().some(c => c.name === 'title')) db.exec('ALTER TABLE job_sources ADD COLUMN title TEXT');
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
  if (!jobColumns.has('posting_metadata')) db.exec("ALTER TABLE jobs ADD COLUMN posting_metadata TEXT NOT NULL DEFAULT '{}'");
  for (const [column, type] of [['description_quality', "TEXT NOT NULL DEFAULT 'title'"], ['description_url', 'TEXT'], ['description_fetched_at', 'TEXT'], ['description_method', 'TEXT']]) {
    if (!jobColumns.has(column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  }
  if (!jobColumns.has('description_quality')) {
    db.exec(`UPDATE jobs SET description_quality=CASE WHEN trim(description)='' THEN 'title' WHEN description LIKE 'Listing summary.%' OR length(description)<250 THEN 'summary' ELSE 'full' END,
      description_url=CASE WHEN description!='' THEN url END,description_fetched_at=CASE WHEN description!='' THEN last_seen END,description_method='source'`);
  }
  if (!jobColumns.has('posting_identity')) {
    db.exec('ALTER TABLE jobs ADD COLUMN posting_identity TEXT');
    const updateIdentity = db.prepare('UPDATE jobs SET posting_identity=? WHERE id=?');
    db.exec('BEGIN');
    try {
      for (const row of db.prepare('SELECT id,url FROM jobs').all()) updateIdentity.run(postingIdentity(row.url), row.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Non-unique: pre-existing duplicates keep their separate application histories.
  db.exec('CREATE INDEX IF NOT EXISTS jobs_posting_identity ON jobs(posting_identity)');
  db.exec(`CREATE TABLE IF NOT EXISTS job_detail_refs(job_id TEXT REFERENCES jobs(id),kind TEXT NOT NULL,external_id TEXT NOT NULL,url TEXT,PRIMARY KEY(job_id,kind,external_id));
    CREATE TABLE IF NOT EXISTS enrichment_queue(job_id TEXT PRIMARY KEY REFERENCES jobs(id),state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,priority REAL NOT NULL DEFAULT 0,next_attempt TEXT NOT NULL,last_attempt TEXT,last_error TEXT,queued_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS enrichment_due ON enrichment_queue(state,next_attempt,priority);
    CREATE TABLE IF NOT EXISTS enrichment_cooldowns(host TEXT PRIMARY KEY,until_at TEXT NOT NULL,message TEXT);
    CREATE TABLE IF NOT EXISTS description_shares(job_id TEXT PRIMARY KEY REFERENCES jobs(id),donor_id TEXT REFERENCES jobs(id));`);
  if (!db.prepare("SELECT value FROM settings WHERE key='profile'").get()) db.prepare('INSERT INTO settings VALUES (?,?)').run('profile', JSON.stringify(DEFAULT_PROFILE));
  if (!db.prepare("SELECT value FROM settings WHERE key='initialized'").get()) {
    const insert = db.prepare('INSERT OR IGNORE INTO sources(kind,name,token) VALUES (?,?,?)');
    DEFAULT_SOURCES.forEach(s => insert.run(...s));
    db.prepare('INSERT INTO settings VALUES (?,?)').run('initialized', 'true');
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='web-sources-v1'").get()) {
    const insert = db.prepare("INSERT OR IGNORE INTO sources(kind,name,token,origin) VALUES (?,?,?,'platform')");
    PLATFORM_SOURCES.forEach(s => insert.run(...s));
    db.prepare('INSERT INTO settings VALUES (?,?)').run('web-sources-v1', 'true');
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='aggregator-sources-v1'").get()) {
    const insert = db.prepare("INSERT OR IGNORE INTO sources(kind,name,token,origin) VALUES (?,?,?,'platform')");
    AGGREGATOR_SOURCES.forEach(s => insert.run(...s));
    db.prepare('INSERT INTO settings VALUES (?,?)').run('aggregator-sources-v1', 'true');
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='workday-sources-v1'").get()) {
    const insert = db.prepare("INSERT OR IGNORE INTO sources(kind,name,token,origin) VALUES (?,?,?,'platform')");
    WORKDAY_SOURCES.forEach(source => insert.run(...source));
    db.prepare('INSERT INTO settings VALUES (?,?)').run('workday-sources-v1', 'true');
  }
  const store = {
    db,
    profile: () => ({ ...DEFAULT_PROFILE, ...JSON.parse(db.prepare("SELECT value FROM settings WHERE key='profile'").get().value) }),
    saveProfile(profile) { db.prepare("UPDATE settings SET value=? WHERE key='profile'").run(JSON.stringify(profile)); },
    sources: () => db.prepare('SELECT * FROM sources ORDER BY id').all(),
    setting(key, fallback = '') { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback; },
    setSetting(key, value) { db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); },
    discover(boards) {
      const insert = db.prepare("INSERT OR IGNORE INTO sources(kind,name,token,origin) VALUES (?,?,?,'discovered')");
      const known = new Set(db.prepare('SELECT kind,token FROM sources').all().map(s => `${s.kind}:${s.token.toLowerCase()}`));
      let added = 0;
      db.exec('BEGIN');
      try {
        for (const board of boards) {
          const token = normalizeBoardToken(board.kind, board.token);
          if (!BOARD_KINDS.includes(board.kind) || !token) continue;
          const key = `${board.kind}:${token.toLowerCase()}`;
          if (known.has(key)) continue;
          added += Number(insert.run(board.kind, String(board.name || token).slice(0, 100), token).changes);
          known.add(key);
        }
        db.exec('COMMIT'); return added;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    statistics() {
      const counts = db.prepare(`SELECT
        (SELECT count(*) FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE COALESCE(a.status,'new') IN ('new','saved') AND EXISTS(SELECT 1 FROM job_sources js JOIN sources s ON js.source_id=s.id WHERE js.job_id=j.id AND js.active=1 AND s.enabled=1)) active,
        (SELECT count(*) FROM applications WHERE status='applied') applied,
        (SELECT count(*) FROM applications WHERE status='saved') saved`).get();
      const platformCounts = Object.fromEntries(db.prepare(`SELECT s.kind,count(DISTINCT js.job_id) count FROM job_sources js JOIN sources s ON s.id=js.source_id
        WHERE EXISTS(SELECT 1 FROM job_sources active_js JOIN sources active_s ON active_s.id=active_js.source_id WHERE active_js.job_id=js.job_id AND active_js.active=1 AND active_s.enabled=1) GROUP BY s.kind`).all().map(row => [row.kind,row.count]));
      return { counts, platformCounts };
    },
    jobs() { return db.prepare(`SELECT j.*, COALESCE(a.status,'new') status,a.applied_at,a.note,
      EXISTS(SELECT 1 FROM job_sources js JOIN sources s ON s.id=js.source_id WHERE js.job_id=j.id AND js.active=1 AND s.enabled=1) active,
      (SELECT group_concat(s.name, ', ') FROM sources s JOIN job_sources js ON js.source_id=s.id WHERE js.job_id=j.id) source_names
      ,(SELECT group_concat(DISTINCT s.kind) FROM sources s JOIN job_sources js ON js.source_id=s.id WHERE js.job_id=j.id) source_kinds
      FROM jobs j LEFT JOIN applications a ON a.job_id=j.id`).all().map(mapJob); },
    job(id) {
      const row = db.prepare(`SELECT j.*,COALESCE(a.status,'new') status,a.applied_at,a.note,
        EXISTS(SELECT 1 FROM job_sources js JOIN sources s ON s.id=js.source_id WHERE js.job_id=j.id AND js.active=1 AND s.enabled=1) active,
        (SELECT group_concat(s.name,', ') FROM sources s JOIN job_sources js ON js.source_id=s.id WHERE js.job_id=j.id) source_names,
        (SELECT group_concat(DISTINCT s.kind) FROM sources s JOIN job_sources js ON js.source_id=s.id WHERE js.job_id=j.id) source_kinds
        FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.id=?`).get(id);
      return row ? mapJob(row) : null;
    },
    ingest(source, jobs, { complete = true, retentionDays = 30, mode = null, warnings = [] } = {}) {
      const now = new Date().toISOString();
      const insert = db.prepare(`INSERT INTO jobs(id,url,title,company,location,description,posted_at,date_basis,terms,years,remote,first_seen,last_seen,description_quality,description_url,description_fetched_at,description_method,posting_identity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET
        title=excluded.title, company=excluded.company, location=excluded.location,
        description=CASE WHEN $titleChanged OR (excluded.description!='' AND (excluded.description_quality='full' OR (jobs.description_quality!='full' AND excluded.description_quality='summary'))) THEN excluded.description ELSE jobs.description END,
        description_quality=CASE WHEN $titleChanged THEN excluded.description_quality WHEN excluded.description_quality='full' THEN 'full' WHEN jobs.description_quality='full' THEN 'full' WHEN excluded.description_quality='summary' THEN 'summary' ELSE jobs.description_quality END,
        description_url=CASE WHEN $titleChanged OR (excluded.description!='' AND (excluded.description_quality='full' OR jobs.description_quality!='full')) THEN excluded.description_url ELSE jobs.description_url END,
        description_fetched_at=CASE WHEN $titleChanged OR (excluded.description!='' AND (excluded.description_quality='full' OR jobs.description_quality!='full')) THEN excluded.description_fetched_at ELSE jobs.description_fetched_at END,
        description_method=CASE WHEN $titleChanged OR (excluded.description!='' AND (excluded.description_quality='full' OR jobs.description_quality!='full')) THEN excluded.description_method ELSE jobs.description_method END,
        posted_at=CASE WHEN excluded.posted_at IS NOT NULL AND excluded.date_basis='published' AND jobs.date_basis!='published' THEN excluded.posted_at ELSE COALESCE(jobs.posted_at,excluded.posted_at) END,
        date_basis=CASE WHEN jobs.posted_at IS NULL OR (excluded.posted_at IS NOT NULL AND excluded.date_basis='published' AND jobs.date_basis!='published') THEN excluded.date_basis ELSE jobs.date_basis END,
        terms=CASE WHEN excluded.terms!='[]' THEN excluded.terms ELSE jobs.terms END,
        years=CASE WHEN excluded.years!='[]' THEN excluded.years ELSE jobs.years END, remote=excluded.remote,last_seen=excluded.last_seen,
        posting_identity=COALESCE(jobs.posting_identity,excluded.posting_identity)`);
      const byUrl = db.prepare('SELECT id,url FROM jobs WHERE url=?');
      const byIdentity = db.prepare('SELECT id,url FROM jobs WHERE posting_identity=? LIMIT 2');
      const member = db.prepare('INSERT INTO job_sources(job_id,source_id,active,last_seen,title) VALUES (?,?,1,?,?) ON CONFLICT(job_id,source_id) DO UPDATE SET active=1,last_seen=excluded.last_seen,title=excluded.title');
      const sourceTitle = db.prepare('SELECT title FROM job_sources WHERE job_id=? AND source_id=?');
      const normalizeTitle = title => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      db.exec('BEGIN');
      try {
        if (complete) db.prepare('UPDATE job_sources SET active=0 WHERE source_id=?').run(source.id);
        else db.prepare('UPDATE job_sources SET active=0 WHERE source_id=? AND last_seen<?').run(source.id, new Date(Date.now() - retentionDays * 86400000).toISOString());
        let count = 0;
        for (const job of jobs) {
          const url = canonicalUrl(job.url);
          if (!url || !job.title || !job.company) continue;
          const identity = postingIdentity(url);
          const exact = byUrl.get(url), aliases = !exact && identity ? byIdentity.all(identity) : [];
          const existing = exact || (aliases.length === 1 ? aliases[0] : null);
          const id = existing?.id || createHash('sha256').update(url).digest('hex').slice(0, 24);
          const quality = descriptionQuality(job);
          const title = job.title.slice(0, 500), previousTitle = sourceTitle.get(id, source.id)?.title;
          // Compare a source with its own last title, not another feed's wording.
          const titleChanged = previousTitle != null && normalizeTitle(previousTitle) !== normalizeTitle(title);
          if (titleChanged) {
            db.prepare('DELETE FROM description_shares WHERE job_id=?').run(id);
            db.prepare('DELETE FROM job_detail_refs WHERE job_id=?').run(id);
          }
          insert.run({ $titleChanged: titleChanged ? 1 : 0 }, id, existing?.url || url, title, job.company.slice(0, 200), job.location || 'Not specified', (job.description || '').slice(0, 60000), job.postedAt || null, job.dateBasis || 'unknown', JSON.stringify(job.terms || []), JSON.stringify(job.years || []), job.remote ? 1 : 0, now, now, quality, canonicalUrl(job.descriptionUrl) || (quality !== 'title' ? url : null), quality !== 'title' ? now : null, 'source', identity);
          for (const ref of job.detailRefs || []) {
            if (['runway', 'jobright'].includes(ref.kind) && /^[a-z\d_-]{1,100}$/i.test(String(ref.externalId || ''))) {
              const added = db.prepare('INSERT OR IGNORE INTO job_detail_refs VALUES (?,?,?,?)').run(id, ref.kind, String(ref.externalId), canonicalUrl(ref.url) || null);
              if (added.changes) db.prepare("UPDATE enrichment_queue SET state='pending',next_attempt=?,last_error=NULL WHERE job_id=? AND state='unavailable'").run(now, id);
            }
          }
          if (job.postingMetadata) store.updatePostingMetadata(id, job);
          member.run(id, source.id, now, title); count++;
        }
        db.prepare('UPDATE sources SET last_success=?,last_error=NULL,last_warning=?,last_mode=?,count=(SELECT count(*) FROM job_sources WHERE source_id=? AND active=1) WHERE id=?').run(now, warnings.join(' ').slice(0, 1000) || null, mode, source.id, source.id);
        db.exec('COMMIT');
        return count;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    detailRefs(id) { return db.prepare('SELECT kind,external_id externalId,url FROM job_detail_refs WHERE job_id=?').all(id); },
    updatePostingMetadata(id, result) {
      if (!result.postingMetadata) return;
      const previous = db.prepare('SELECT posting_metadata,posted_at,date_basis,location FROM jobs WHERE id=?').get(id);
      if (!previous) return;
      const old = JSON.parse(previous.posting_metadata || '{}'), incoming = result.postingMetadata;
      const metadata = old.workdayDetailsFetchedAt && !incoming.workdayDetailsFetchedAt ? { ...incoming, ...old } : { ...old, ...incoming };
      const upgradeDate = result.postedAt && (!previous.posted_at || (result.dateBasis === 'published' && previous.date_basis !== 'published'));
      const location = metadata.workdayDetailsFetchedAt && metadata.locations?.length ? metadata.locations.join(' · ') : previous.location;
      const arrangement = metadata.workplaceType || '';
      const remote = arrangement ? (/remote/i.test(arrangement) && !/hybrid|on.?site/i.test(arrangement)) : /\bremote\b/i.test(location);
      db.prepare('UPDATE jobs SET posting_metadata=?,location=?,remote=?,posted_at=?,date_basis=? WHERE id=?').run(JSON.stringify(metadata), location, remote ? 1 : 0, upgradeDate ? result.postedAt : previous.posted_at, upgradeDate ? result.dateBasis : previous.date_basis, id);
    },
    updateDescription(id, result) {
      store.updatePostingMetadata(id, result);
      if (result.postedAt && result.dateBasis === 'published') {
        db.prepare("UPDATE jobs SET posted_at=?,date_basis='published' WHERE id=? AND (posted_at IS NULL OR date_basis!='published')").run(result.postedAt, id);
      }
      const current = db.prepare('SELECT description_quality FROM jobs WHERE id=?').get(id);
      if (!current) return false;
      const quality = descriptionQuality(result);
      if (quality !== 'full' && current.description_quality === 'full') return false;
      db.prepare('UPDATE jobs SET description=?,description_quality=?,description_url=?,description_fetched_at=?,description_method=? WHERE id=?')
        .run(String(result.description).slice(0, 60000), quality, canonicalUrl(result.url) || null, new Date().toISOString(), result.method || 'fetched', id);
      return true;
    },
    close: () => db.close()
  };
  return store;
}
