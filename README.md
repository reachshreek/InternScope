# Internscope

A complete, private internship discovery web app. Upload your resume or paste its text/source, set your preferences, and browse a feed ranked by resume alignment and freshness. Marking a posting **Applied** immediately moves it out of Discover and into Applied. That decision survives refreshes and restarts.

## Start on this Windows computer

Double-click **Start-Internscope.cmd**, then open **http://localhost:3000**. The project includes a local Node runtime in `.tools` on the machine where it was built. Keep the program running for automatic updates; the browser tab can be closed.

On another machine, install **Node.js 24 or newer**, then run:

```sh
npm ci
npm start
```

The first refresh begins automatically. Browse results while sources finish; a separate background queue progressively retrieves full employer descriptions.

## What it does

- PDF, DOCX, TXT, Markdown, LaTeX, HTML, JSON, JSX, and TSX resume uploads (5 MB maximum), plus a paste editor. Resume source code is read as text and never executed. Scanned PDFs need OCR before uploading, or paste their text.
- Resume skill extraction and explainable percentage scores, including matched skills and skills not found in the resume.
- Location, remote, season, year, role, keyword, and exclusion preferences. Choose whether postings with unknown season/year are included. Unknown location doesn't satisfy a location filter. Keywords rank rather than exclude.
- A live Simplify & Pitt CSC internship list, automatically discovered Greenhouse and Ashby company boards, direct LinkedIn/Indeed/ZipRecruiter public-search connectors, Runway, and Intern List's engineering tables. Connect additional company boards from the UI.
- Scheduled refresh every two hours, manual refresh, source error reporting, and last/next refresh metadata.
- Deduplication by normalized posting URL and strong ATS job identifiers, with tracking parameters stripped. Unrelated mirrors without a shared identifier may still appear separately.
- Saved shortlist, Applied history, undo/restore, notes, and JSON application export. Application tracking records your action; submit applications on the original employer site.
- Persistent SQLite database, responsive layout, keyboard-accessible dialogs, safe text rendering, bounded source requests, and local-only binding by default.

Applied, Hide, Save and Restore update the visible posting immediately and save only that job's status and queue priority. A failed save restores the card and counters. Rapid actions share one follow-up feed/state refresh, and older responses cannot bring a removed card back. Match results are reused while the resume, role/keyword preferences and posting text remain unchanged; new descriptions automatically invalidate their cached score. State polling uses database counters instead of loading every job description.

## Matching and dates

Base score: 65% recognized skill coverage + 35% shared meaningful terms. Role preferences adjust 15% of the score; keyword preferences adjust 10%. Scores measure resume text alignment, **not acceptance probability**. Maximum score is 99%. A missing resume displays no score. Postings explicitly show **Title only**, **Summary**, or **Full description**. Incomplete postings display an **ESTIMATE** label and provisional score, which updates when full details become available. The Posting details filter can show only full descriptions.

Recommended rank: 72% match + 28% freshness. Freshness decays exponentially over ten days. You can instead sort by newest or best match. When the published date is missing, ranking uses first discovery and labels it accordingly.

- **Posted:** company-provided publication timestamp.
- **Listed:** date recorded by the community feed, which may differ from the employer's publication date.
- **First seen:** time this app discovered a posting with no publication date.

Greenhouse `updated_at` is never treated as a publication date. Dates do not reset on refresh. A source's last successful complete response controls whether its jobs are active; temporary source failures keep the previous results. A posting remains active if another enabled source still lists it. Applied history and saved entries remain available after a job leaves its feed.

The app searches connected sources, not every website or every posting on a platform. A community listing may contain only a title; direct boards and enriched LinkedIn postings provide richer descriptions. Matching recognizes technology, business, design, finance, science, and other skills. The community feed and ATS discovery skew toward technology and engineering. Public-feed and accessible public-search discovery need no API key; an optional search-index fallback requires your own SerpApi key.

## Expanded platform discovery

Greenhouse and Ashby publish public **per-company** job-board APIs, not a global list of every company. Internscope extracts board identifiers from current and historical links in the community feed, prioritizes recent active listings, and adds discovered boards to a persistent catalog. **Every manual and automatic job refresh re-fetches every enabled source, including all enabled discovered boards and boards found during that same refresh.** There is no rotating board limit; `BOARD_SCAN_BATCH` is obsolete and ignored. Bounded concurrency controls request load while keeping every board in the refresh. Retired boards returning 404/410 are retained in the catalog and disabled; you can re-enable them. Coverage and individual source status are visible in Job sources. Discovery is broad but cannot guarantee every Greenhouse/Ashby board exists in the catalog.

LinkedIn, Indeed, and ZipRecruiter connectors search public results from the past seven days, ordered by recency where supported. Queries use explicit role and location preferences; **resume text is never included in searches**. Up to six query combinations are checked. Indeed and ZipRecruiter try JobSpy first; the built-in public-page collectors check `SEARCH_PAGES` pages per query when needed. Pagination uses the number of actual result cards, rather than assuming every LinkedIn page has 25 jobs. Missing descriptions enter the persistent backfill queue; this replaces repeatedly expanding only the first ten results. Login walls, security checks and HTTP 429 are reported as access failures; no login sessions, CAPTCHA solvers or rotating proxies are configured.

Live verification from this machine found LinkedIn public results accessible, JobSpy able to retrieve Indeed internships with descriptions, and partial ZipRecruiter results before a later query returned HTTP 403. Both platforms' built-in HTML searches previously returned security checks. These are real access limitations, not empty searches. The app retries enabled platforms on each refresh, reports errors, and keeps previously collected results when a request fails. If you connect a **SerpApi** key in Job sources (or set `SERPAPI_API_KEY` on the server), restricted searches can query Google Jobs instead. Each refresh requests fresh index responses with `no_cache=true`; feed and public-page requests also bypass client caching and request revalidation from upstream caches. The fallback only imports results with application links belonging to the requested platform. It is search-index coverage, not a direct scrape or a guarantee of complete/current platform coverage. The key's plan/quota applies: fallback uses one request per query per restricted platform per refresh, up to six per platform, and fresh queries consume provider quota. No subscription or paid service is activated automatically.

Search pages are partial windows, so absent results are not marked closed just because they weren't on the latest page. Search memberships expire after 30 days without being seen on a subsequent successful search; applied history and notes remain. Exact source dates are labeled Posted; relative dates (such as “2 days ago”) are labeled **Approx. posted**. URLs are normalized to stable LinkedIn job IDs and Indeed `jk` IDs to avoid duplicates between search pages.

### JobSpy for Indeed and ZipRecruiter

[JobSpy](https://github.com/speedyapply/JobSpy) (`python-jobspy==1.4.1`) runs in an asynchronous Python subprocess on **every enabled Indeed/ZipRecruiter refresh**. Searches are never served from a saved JobSpy response. Results enter the same canonical URL deduplication, resume matching, description backfill and Applied/notes history as other sources. Platform-reported dates are labeled **Listed**, rather than claimed as independently verified employer publication dates. Only internship records with valid links belonging to the requested platform are imported.

On this computer the private environment is already installed at `.tools/jobspy`. For another Windows installation, run `powershell -ExecutionPolicy Bypass -File Setup-JobSpy.ps1` once, then restart the app. The script uses `uv` when available or an installed Python 3.10+. On macOS/Linux:

```sh
python3 -m venv .tools/jobspy
.tools/jobspy/bin/python -m pip install -r requirements-jobspy.txt
```

Docker builds install Python and JobSpy automatically. `JOBSPY_PYTHON` can select a different interpreter; paths are passed directly without a shell. `JOBSPY_ENABLED=0` disables JobSpy and retains the existing HTML/index pipeline. Default limits are `JOBSPY_RESULTS=60` per query (maximum 200), six queries per platform, `JOBSPY_COUNTRY=USA` for Indeed, and `JOBSPY_TIMEOUT_SECONDS=180` per platform (maximum 300). Queries use the same explicit role/location preferences as other searches, with the remote-only flag when selected. Country selection is independent of city/location text; set `JOBSPY_COUNTRY=Canada`, for example, when searching Canadian Indeed listings.

Searches run outside Node's request handler, preserving responsive Hide/Applied actions. JSON results stream after each completed query; timeout or later-query failures retain completed results and show a partial-results warning. Description expansion remains in the separate background queue; JobSpy does not fetch every individual detail page during listing refresh. Missing Python/dependencies, access blocks and worker errors fall back to the existing public search and optional SerpApi index. Failed sources retain prior results. JobSpy is not a guarantee of unrestricted access or complete platform coverage. Source rows identify successful JobSpy collection explicitly.

### Runway and Intern List

Both sources are enabled automatically when the app upgrades, without changing existing preferences, applications, or disabled-source choices. They appear in source status, coverage, and the platform filter and re-fetch fresh public data on **every manual and scheduled refresh**. Neither connector uses an account, an API key, or your resume.

- **Runway** (`joinrunway.io`, public listings at `app.joinrunway.io/explore`): reads the same logged-out, read-only tRPC listing queries used by its public page. Retrieves internships and co-ops separately, ordered newest first; follows the real date/ID cursor with its SuperJSON date metadata. Uses original employer application URLs when available, which also deduplicates against direct company feeds. Public detail identifiers are saved for the background/on-demand reader. The app calculates its own match scores and ignores Runway's scores.
- **Intern List · Engineering** (`https://www.intern-list.com/?k=eng`): reads the public engineering table embedded from Jobright. Covers the US and Canada engineering categories, following the site's public read-only POST search with `position`/`count` pagination. Imports title, company, location, compensation and qualification summaries, hiring season/year, and stable Jobright posting links. Summaries are identified as abbreviated and produce limited-confidence matches; they are not represented as full descriptions.

By default, each connector retrieves up to **10 recent pages per role type or region** (`AGGREGATOR_PAGES`, configurable 1–100). Runway pages contain up to 40 rows; Intern List pages up to 50. This prioritizes fresh postings and bounds each source's work; it does not claim to import their entire historical catalogs. Partial windows preserve earlier results until the existing retention policy expires them, and warnings disclose when older pages remain or a later request fails. Dates from these aggregators are labeled **Listed** rather than claimed as independently verified employer publication dates. Original posting timestamps are never replaced with the scrape time. New Greenhouse/Ashby boards encountered through these sources are discovered and checked in the same refresh.

## Workday and expanded company discovery

Internscope now discovers **Workday and Lever** company boards from community,
Runway, and Intern List posting links, alongside Greenhouse and Ashby. European
Lever/Greenhouse boards retain their region; dotted Ashby identifiers are supported.
Job sources accepts a full public careers URL for any supported company provider,
or a board identifier (`cirrus@eu` selects European Lever).

Four Workday boards are added on upgrade: NVIDIA, Micron, Analog Devices, and KLA.
Existing disabled-source choices are preserved. Workday probes the public
`workerSubType` categories, selects explicit internship/co-op categories when
available, and follows pagination using the actual number of returned listings.
Without those categories it searches both `intern` and `co-op`, excludes unrelated
fuzzy matches, and labels coverage partial. `WORKDAY_PAGES` defaults to 100 pages
per category/search (20 listings per page, configurable 1–500). Page limits,
repeated pages, and later failures produce visible warnings and preserve previous
results. Full descriptions use the existing persistent background queue. Relative
listing dates are labeled approximate until the public detail API supplies its
exact publication date. "30+ days ago" remains a lower bound. Workday details also
populate all published locations, remote/hybrid/on-site arrangement when supplied,
full-time/part-time schedule, and requisition ID. Existing jobs with full descriptions
also enter the metadata backfill queue; opening a job prioritizes its details.

Deduplication also recognizes strong ATS job identifiers across Greenhouse board
aliases and employer `gh_jid` links, Lever/Ashby application links, and localized
Workday URLs. New aliases reuse an existing unambiguous job record, preserving its
ID, first discovery, application status, and notes. Similar titles alone never
merge records. Existing duplicate records with separate histories are retained;
ambiguous identity matches are not automatically merged.

These adaptations were inspired by [Vigil](https://github.com/AbhigyaGoel/vigil).
See [third-party attribution and license](THIRD_PARTY_NOTICES.md). Run
`node scripts/verify-ats.js` for bounded, read-only live source probes.

## Full descriptions and progressive backfill

The app maintains a persistent SQLite queue for incomplete active postings. It prioritizes jobs matching saved preferences, saved jobs, freshness and resume alignment; waiting jobs gain an age boost. Each completed request moves forward in the queue, rather than re-fetching the same newest ten jobs on every refresh. Queue state, attempts, failures, source cooldowns and public detail references survive restarts. Interrupted work is safely retried. Every completed listing refresh resynchronizes the queue; profile/source/application changes reprioritize it. Applied and hidden jobs are excluded from automatic backfill, but you can still fetch their details explicitly by opening them.

The background worker processes up to `ENRICH_BATCH_SIZE` jobs per cycle (default 36), waits `ENRICH_INTERVAL_SECONDS` after a batch (default 2), and allows up to `ENRICH_CONCURRENCY` concurrent detail reads across background and on-demand work (default 6, maximum 12). It spreads work across hosts within a bounded priority window so one busy site does not occupy every worker. Requests to the same host are paced. A rate limit pauses that host for at least one hour (respecting Retry-After); an access block pauses it for six hours. Other failures back off exponentially; inaccessible/unsupported pages retry after seven days. Failed attempts preserve the current title/summary and never fabricate missing qualifications. Larger backlogs fill gradually; the Posting details panel shows progress.

Listing scans run up to `SCAN_CONCURRENCY` sources simultaneously (default 16, maximum 32), with at most four collectors per shared API host and one per Workday company host. Slow search platforms and aggregators no longer block the company-board scan. Newly discovered boards join the same running queue. Greenhouse listing scans fetch metadata in one request; full descriptions and publication dates use the persistent background queue. The queue resynchronizes during long scans at most once a minute and when a scan finishes. Workday pagination and its per-company pacing remain unchanged.

Each completed source is checkpointed, including failed attempts. After a restart, an interrupted scan resumes its remaining sources and preserves its progress count; a subsequent new refresh checks every enabled source again. A scan started by an older version without checkpoints must restart once when upgrading.

Opening an incomplete posting moves it to the front and requests its full public description. The dialog updates its description, score, matched skills and provenance as the request completes, while preserving unsaved notes. Duplicate opens share the in-flight request. Existing retry/cooldown periods are respected. The reader supports Greenhouse, Ashby, Lever, public Workday job-detail APIs, public Runway details, LinkedIn guest details, JobPosting JSON-LD, public Jobright data and recognizable employer description sections. It never treats a generic page body as a full description. Content requiring a login, CAPTCHA or an unsupported JavaScript renderer remains labeled incomplete.

Full descriptions also propagate across **exact normalized company/title/location matches** when season/year and posting dates are compatible and the donor description is unambiguous. Broad locations such as “Remote” and conflicting donor descriptions do not use this fallback. This shares text and its source URL; it does not merge applications or change Applied status. Canonical posting URLs already share the same job record. Lower-quality feed summaries cannot overwrite a full description. A changed posting title invalidates the cached text and queues a new read. Each full description exposes its source and retrieval time; adding details never changes the original posting date or first-discovered timestamp.

Detail fetching only visits public HTTPS endpoints. DNS answers are checked and pinned to the connection; private/local/reserved addresses, URL credentials, custom ports and unsafe redirects are rejected. Responses, redirects, DNS and network timeouts are bounded. No resume text, cookies, login sessions or API credentials accompany description requests.

## Continuous updates and hosting

Automatic refresh runs in the Node server, independently of the browser, using the same full re-fetch pipeline as the **Refresh jobs** button. Reloading the browser page only displays the current stored results; use Refresh jobs to start a new scrape immediately. Concurrent refresh requests share the running scan instead of starting overlapping scrapes. Refreshing discovers new postings and updates existing ones while preserving Applied status and notes. The scheduler pauses when your computer sleeps or the server stops. On restart, overdue refreshes run shortly after startup. For continuous coverage, run on an always-on machine or deploy the included Docker container with persistent storage:

```sh
docker compose up -d --build
```

Compose binds the app to localhost and retains `/app/data` in a named volume. This is a **single-user workspace**. Before exposing it on a network, put an authenticated reverse proxy in front of it; the app intentionally has no account system. Do not publish an unprotected instance containing a resume. Multi-user hosting would require authentication and per-user data isolation.

Optional settings in `.env` (copy `.env.example`): `HOST`, `PORT`, `DATA_DIR`, `REFRESH_HOURS`, `SCAN_CONCURRENCY` (default 16, max 32), `SEARCH_PAGES` (default 3, max 10), `AGGREGATOR_PAGES` (default 10, max 100), `ENRICH_BATCH_SIZE` (default 36, max 100), `ENRICH_INTERVAL_SECONDS` (default 2), `ENRICH_CONCURRENCY` (default 6, max 12), and `SERPAPI_API_KEY`. The old per-refresh `SEARCH_DETAILS`/`AGGREGATOR_DETAILS` limits only affect standalone collector scripts; the app uses the persistent queue instead. An optional `CRON_SECRET` enables `POST /api/cron/refresh` with `Authorization: Bearer <secret>` for an external scheduler. The built-in scheduler does not need it. Use one server process per data directory.

## Data and privacy

Resume extraction and matching happen locally on the server. The app makes outbound requests to public job feeds and sends role/location search preferences to job-search sites (and SerpApi if configured); it does not send resume text to those sites or to an AI provider. Uploaded bytes are held in memory for extraction, then discarded; extracted text, preferences, source data, and application notes live in `data/internscope.sqlite`. A key saved through the UI is stored in this same private local database and never returned by the state/export APIs; disconnecting removes its active value. An environment key takes precedence and can only be changed in the environment. Removing data is not a forensic secure erase of SQLite pages/backups. Application exports do not include your resume or keys. Back up the entire data directory while the server is stopped.

Source implementations follow the public provider documentation:

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Simplify & Pitt CSC internship list](https://github.com/SimplifyJobs/Summer2027-Internships), maintained by their contributors. Their feed remains owned/licensed by its maintainers.
- [SerpApi Google Jobs API](https://serpapi.com/google-jobs-api), optional indexed-search fallback.
- [Runway public job board](https://app.joinrunway.io/explore).
- [Intern List engineering listings](https://www.intern-list.com/?k=eng), via its public Jobright embedded tables.

## Development and checks

```sh
npm run dev
npm run check
npm test
npm run test:browser
npm run test:performance
npm run test:scrape-performance
npm run test:jobspy
```

Browser checks use an installed Chrome or Edge (set `BROWSER_CHANNEL` if necessary). They cover resume upload/paste, preferences, posting details, applied/undo/restore, saved jobs, notes, responsive overflow, client errors, delayed/concurrent status saves, stale responses and rollback after a failed save against isolated test databases. The performance command benchmarks a temporary copy of the existing catalog and never changes the real application's history or notes. Test fixtures never become real search results.

Main files: `server/index.js` (HTTP API), `server/providers.js` (discovery adapters), `server/refresh.js` (scheduler), `server/matching.js` (scoring/filtering), `server/db.js` (storage), and `public/` (interface). All app code is included; there is no build step.
