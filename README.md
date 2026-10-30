This is Internscope, an app I made that scrapes job sob boards and ocmpany sites and finds jobs/internships that best match to your resume and preferences

# Internscope

Internscope brings internship listings from job boards and company career sites into one personal feed. Add your resume, choose your preferences, and browse postings ranked by how closely they match your experience and how recently they were posted.

## How it works

1. **Add your resume.** Upload a PDF, DOCX, or supported text file, or paste your resume directly. Internscope extracts text and recognizes skills to compare with postings.
2. **Set your preferences.** Choose roles, locations, remote options, seasons, years, keywords, and exclusions. These help filter and rank the feed.
3. **Browse matches.** Each posting shows its company, role, location, available description, and an explainable match score. You can sort by recommendation, newest, or best match.
4. **Track your applications.** Save interesting postings, hide ones you do not want, or mark them Applied. Add notes, undo status changes, and export your application history. Apply through the original employer link; marking Applied records your progress.

## How it scrapes

Internscope uses a separate collector for each supported source. Collectors read public job-board APIs, public page HTML, or the public listing endpoints used by a site's interface, then turn those responses into a common posting format.

- **Company career boards:** Greenhouse, Lever, Ashby, and Workday collectors request listings for individual companies. Workday searches use internship and co-op categories where available, with keyword searches as a fallback.
- **Community listings:** The Simplify & Pitt CSC internship list supplies postings and links to employer boards. Internscope extracts supported board identifiers from those links and adds newly discovered companies to the source catalog.
- **Job-search platforms:** LinkedIn, Indeed, and ZipRecruiter collectors attempt public searches using your role and location preferences. Access depends on what each site makes publicly available.
- **Aggregators:** Runway and Intern List's engineering listings provide additional internships and employer links. Supported company boards found through these sources can join the same scan.

Searches start when you open the app and repeat every two hours while the tab remains open. You can also refresh manually. Newly discovered boards join the running scan. Up to 12 source requests run together, with limits per host so one company does not receive many simultaneous listing requests.

Each source has a bounded request budget. Paged sources check a limited recent window, currently two pages per query or category. This keeps searches moving but means a scan may cover only part of a site's catalog. Source errors and partial-result warnings appear in the app; failed requests retain earlier results from the current tab.

Posting URLs are normalized and supported employer job identifiers are used to reduce duplicates, including links with different tracking parameters. Listings without a shared identifier can still appear separately.

## Full descriptions

Some listing feeds provide only a title and basic facts. Workday, for example, requires a separate job-detail request for its full description.

Internscope automatically queues incomplete postings from supported employer boards while the tab is open. Saved jobs and preference matches receive priority. Up to four detail requests run together, with one request per host and a pause between requests. Opening a posting prioritizes it in the same queue instead of creating a duplicate request.

Successful reads update descriptions and match scores. Workday details can also supply publication dates, locations, schedules, work arrangements, and requisition IDs. Later lightweight scans preserve richer descriptions and exact dates already fetched.

Postings are labeled **Title only**, **Summary**, or **Full description**. Incomplete postings have provisional match scores. Rate limits and access blocks pause requests to the affected host; temporary failures retry with delays. Some postings remain incomplete when public details are unavailable. Applied and hidden postings are excluded from automatic detail fetching.

## How matching works

Matching runs in your browser using recognized skills and meaningful words shared between your resume and the posting. The base score combines 65% skill coverage and 35% shared terms, with adjustments for preferred roles and keywords. Each match includes recognized skills found in your resume and skills that were not found.

Scores describe text alignment, not your probability of getting an interview or offer. Missing resume wording does not necessarily mean you lack a skill. Scores can change when a full description becomes available.

The recommended feed combines 72% match and 28% freshness. Dates distinguish employer publication dates, dates supplied by listing sources, approximate dates, and the first time Internscope discovered a posting.

## Your data

Your resume text, preferences, connected sources, saved postings, application history, hidden postings, and notes are stored in this browser. PDFs are read in the browser. Other supported uploads are sent to the app's server for text extraction without being saved there. Uploads must be under 4 MB.

Your resume is not included in requests to job sites. Role and location preferences can be used in public searches. Matching does not require an AI service.

Ordinary search results and the detail queue live in tab memory. Reloading starts a fresh search using the saved source catalog; closing the tab stops its work. Clearing site storage removes your saved workspace, and other browsers or devices have separate workspaces. Export applications to keep a copy of your application history.

## Coverage and limitations

Internscope searches its connected sources, rather than every job on the internet. Public sites may block automated requests, require login, or provide incomplete data. The app does not bypass login walls or CAPTCHAs. Its community and aggregator sources lean toward technology and engineering internships.

The current app uses its public API and page collectors. JobSpy is disabled. When a server-side SerpApi key is configured, Indeed and ZipRecruiter use Google Jobs indexed results and keep only postings with application links to the requested platform. This provides partial indexed coverage, rather than a complete direct scrape. Each platform uses up to two queries per refresh, prioritizing preferred roles and allowing provider caching to reduce quota use. Without a key, the app attempts public search pages. Job sources shows whether indexed search is connected; the key is never sent to the browser. Provider quota and pricing apply.
