const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name, className = '') => `<svg aria-hidden="true" class="${className}"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { view: 'new', page: 1, maxAge: 0, q: '', platform: '', quality: '', sort: 'recommended', minScore: 0, data: null, jobs: [], pages: 0, total: 0, request: 0, modal: null, lastRun: null, detailId: null, enrichmentRevision: null };
const platformNames = { greenhouse: 'Greenhouse', ashby: 'Ashby', workday: 'Workday', linkedin: 'LinkedIn', indeed: 'Indeed', ziprecruiter: 'ZipRecruiter', runway: 'Runway', internlist: 'Intern List (Engineering)', lever: 'Lever', community: 'Community feed' };
let toastTimer, undoAction, searchTimer, pollTimer, detailTimer, detailToken = 0;
const pendingJobs = new Map();
let mutationRevision = 0, reconcileTimer, stateRequest = 0, lastScanFeedAt = 0;

async function api(path, options = {}) {
  const mutating = options.method && !['GET', 'HEAD'].includes(options.method);
  if (mutating) mutationRevision++;
  try {
  if (window.browserWorkspace) return await (await window.browserWorkspace).api(path, options);
  const response = await fetch(`/api${path}`, { ...options, headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete this request.');
  return data;
  } finally { if (mutating) mutationRevision++; }
}
function notify(message, undo) {
  clearTimeout(toastTimer); undoAction = undo;
  $('#toast-message').textContent = message;
  $('#toast-undo').classList.toggle('hidden', !undo);
  $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), undo ? 12000 : 6500);
}
function humanDate(value, dateOnly = false) { return value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : { hour: 'numeric', minute: '2-digit' }) }) : 'Not provided'; }
function relative(value) {
  if (!value) return 'Date unknown';
  const hours = Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : days < 30 ? `${days} days ago` : new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function scoreMarkup(match, extra = '') {
  const score = match.score;
  return `<div class="score ${score === null ? 'empty' : score >= 70 ? '' : score >= 35 ? 'medium' : 'low'} ${extra}" title="${score === null ? 'Add a resume to calculate your match' : match.provisional ? 'Provisional estimate based on incomplete posting details; it will update when a full description is available.' : 'Resume alignment score; not an acceptance probability'}"><strong>${score === null ? '—' : `${score}<span>%</span>`}</strong><small>${score === null ? 'ADD RESUME' : match.provisional ? 'ESTIMATE' : 'MATCH'}</small></div>`;
}
function companyLogo(job) {
  const initials = job.company.split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
  const tone = [...job.company].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5;
  return `<div class="company-logo tone-${tone}" aria-hidden="true">${escape(initials)}</div>`;
}
function tag(value, className = '') { return `<span class="tag ${className}">${escape(value)}</span>`; }

async function loadState({ refreshJobs = false, skipJobs = false } = {}) {
  const revision = mutationRevision, request = ++stateRequest;
  try {
    const data = await api('/state');
    if (request !== stateRequest) return;
    if (pendingJobs.size || revision !== mutationRevision) {
      clearTimeout(pollTimer); pollTimer = setTimeout(() => loadState(), 500); return;
    }
    const wasRunning = state.data?.refresh.running;
    const lastId = data.refresh.last?.id + ':' + data.refresh.last?.finished_at;
    const changed = state.lastRun && lastId !== state.lastRun;
    const detailsChanged = state.enrichmentRevision !== null && state.enrichmentRevision !== data.enrichment?.revision;
    const scanAdvanced = data.refresh.running && data.refresh.progress?.checked !== state.data?.refresh.progress?.checked && Date.now() - lastScanFeedAt >= 10000;
    state.enrichmentRevision = data.enrichment?.revision;
    state.lastRun = lastId; state.data = data;
    renderState();
    if (!skipJobs && (refreshJobs || changed || detailsChanged || scanAdvanced || (wasRunning && !data.refresh.running))) {
      lastScanFeedAt = Date.now(); await loadJobs();
    }
    if (request !== stateRequest) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => loadState(), data.refresh.running ? 2000 : data.enrichment?.running ? 5000 : 15000);
  } catch (error) {
    if (request !== stateRequest) return;
    $('#connection-banner').classList.remove('hidden');
    $('#connection-banner').classList.add('error');
    $('#connection-banner').textContent = `Can't reach your workspace. Make sure Internscope is running. ${error.message}`;
    clearTimeout(pollTimer); pollTimer = setTimeout(() => loadState({ refreshJobs: true }), 15000);
  }
}
function renderState() {
  const { profile, skills, counts, refresh, sources } = state.data;
  if (state.data.browserOnly) {
    $('#enrichment-progress').parentElement.querySelector('.privacy-note').textContent = 'Open a posting to fetch its employer details. Searches run while this tab is open.';
    $('.resume-panel .privacy-note').textContent = 'Saved in this browser. Clearing site data removes your workspace.';
    $('.autopilot p').textContent = 'Checks every two hours while this tab is open.';
  }
  $('#nav-new').textContent = counts.active.toLocaleString();
  $('#nav-saved').textContent = counts.saved.toLocaleString();
  $('#nav-applied').textContent = counts.applied.toLocaleString();
  const details = state.data.enrichment;
  if (details) {
    const full = details.quality.full || 0, total = Object.values(details.quality).reduce((sum,n) => sum+n, 0);
    $('#enrichment-progress').textContent = `${full.toLocaleString()} of ${total.toLocaleString()} active postings have full descriptions. ${(details.counts.pending || 0).toLocaleString()} queued${details.running ? ' · fetching details' : ''}${details.cooldowns.length ? ` · ${details.cooldowns.length} sites cooling down` : ''}.`;
    $('#enrichment-dot').classList.toggle('busy', details.running);
  }
  const hasResume = profile.resume.trim().length > 0;
  $('#resume-dot').classList.toggle('connected', hasResume);
  $('#resume-state').textContent = hasResume ? 'READY TO MATCH' : 'GET STARTED';
  $('#resume-title').textContent = hasResume ? 'Your story, connected.' : 'Good matches start with your story.';
  $('#resume-description').textContent = hasResume ? `${profile.resumeName || 'Your resume'} · ${skills.length} recognized skills. Update it anytime as your experience grows.` : "Upload your resume or paste its source. We'll take it from there.";
  $('#resume-skills').innerHTML = skills.slice(0, 5).map(s => tag(s, 'skill')).join('') + (skills.length > 5 ? tag(`+${skills.length - 5} more`) : '');
  $('#resume-side-button').innerHTML = icon(hasResume ? 'file' : 'upload') + (hasResume ? 'View & update resume' : 'Add resume');
  $('#hero-text').textContent = hasResume ? 'Your experience is the starting point. Explore fresh internships matched to what you bring.' : "Add your resume. We'll connect your experience with internships worth your time.";
  $('#hero-button').innerHTML = hasResume ? `Refine your preferences ${icon('arrow')}` : `Add your resume ${icon('arrow')}`;
  $('#hero-button').dataset.open = hasResume ? 'preferences' : 'resume';
  $('#preference-summary').innerHTML = preference('pin', 'LOCATION', profile.remoteOnly ? 'Remote only' : (profile.locations || 'Open to anywhere') + (profile.locations && profile.includeRemote ? ' + remote' : ''))
    + preference('clock', 'WHEN', [profile.season ? profile.season[0].toUpperCase() + profile.season.slice(1) : 'Any season', profile.year].filter(Boolean).join(' '))
    + preference('search', 'LOOKING FOR', profile.roles || 'All internship roles');
  const enabled = sources.filter(s => s.enabled), errors = enabled.filter(s => s.last_error);
  const checked = Math.max(0, Number(refresh.progress?.checked) || 0);
  // Early discovery batches report their own total; include all known enabled
  // sources so finishing the first feed never looks like finishing the search.
  const total = Math.max(checked, Number(refresh.progress?.total) || 0, enabled.length);
  const percentage = refresh.running ? (total ? Math.min(99, Math.floor(checked / total * 100)) : 0) : refresh.last?.finished_at ? 100 : 0;
  $('#search-progress').classList.toggle('hidden', !refresh.running && !refresh.last?.finished_at);
  $('#search-progress').classList.toggle('is-running', refresh.running);
  $('#search-progress-label').textContent = refresh.running ? 'Searching sources' : 'Search finished';
  $('#search-progress-percentage').textContent = `${percentage}%`;
  $('#search-progress-meter').value = percentage;
  $('#search-progress-meter').textContent = `${percentage}%`;
  $('#search-progress-detail').textContent = refresh.running
    ? `${checked.toLocaleString()} of ${total.toLocaleString()} sources checked${refresh.progress?.discovered ? ` · ${refresh.progress.discovered.toLocaleString()} new boards found` : ''}. You can keep browsing.`
    : `Search finished${errors.length ? ` · ${errors.length.toLocaleString()} source${errors.length === 1 ? ' needs' : 's need'} attention` : ''}.`;
  $('#refresh-button').disabled = refresh.running;
  $('#refresh-button').innerHTML = icon('refresh', refresh.running ? 'spinning' : '') + `<span>${refresh.running ? `Searching · ${percentage}%` : 'Refresh jobs'}</span>`;
  $('#refresh-dot').classList.toggle('busy', refresh.running);
  $('#refresh-dot').classList.toggle('warning', errors.length > 0 && !refresh.running);
  $('#refresh-title').textContent = refresh.running ? 'Looking for fresh possibilities' : refresh.last?.finished_at ? 'Your search is up to date' : 'Ready for your first search';
  if (errors.length === enabled.length && enabled.length && !refresh.running) $('#refresh-title').textContent = 'Sources need attention';
  $('#refresh-status').textContent = refresh.running ? `${percentage}% complete · ${checked.toLocaleString()} of ${total.toLocaleString()} sources checked. You can keep browsing.` : refresh.last?.finished_at ? `Last checked ${relative(refresh.last.finished_at).toLowerCase()}. Checks every ${refresh.intervalHours} hours while the app is running.` : 'Your first refresh will begin automatically.';
  $('#source-summary').innerHTML = `${enabled.length} connected sources${errors.length ? ` · ${errors.length} need attention` : ''} ${icon('chevron')}`;
  const banner = $('#connection-banner');
  banner.classList.remove('error');
  banner.classList.toggle('hidden', !errors.length || refresh.running);
  if (errors.length && !refresh.running) banner.innerHTML = `<span>${errors.length} source${errors.length === 1 ? '' : 's'} couldn't be refreshed. Existing results are still available.</span><button class="text-button" data-open="sources">View details ${icon('arrow')}</button>`;
  if (state.data.storageError) { banner.classList.remove('hidden'); banner.classList.add('error'); banner.textContent = state.data.storageError; }
}
function preference(svg, label, value) { return `<div class="preference">${icon(svg)}<div><span class="preference-label">${label}</span><span class="preference-value">${escape(value)}</span></div></div>`; }

async function loadJobs() {
  const request = ++state.request;
  if (pendingJobs.size) { reconcileJobs(); return; }
  const revision = mutationRevision;
  const params = new URLSearchParams({ view: state.view, page: state.page, q: state.q, platform: state.platform, quality: state.quality, sort: state.sort, minScore: state.minScore, maxAge: state.maxAge });
  try {
    const data = await api(`/jobs?${params}`);
    if (request !== state.request || revision !== mutationRevision || pendingJobs.size) return;
    state.jobs = data.jobs; state.total = data.total; state.pages = data.pages;
    if (data.pages && state.page > data.pages) { state.page = data.pages; return loadJobs(); }
    renderJobs();
  } catch (error) {
    if (request !== state.request) return;
    $('#jobs').innerHTML = `<div class="empty-state">${icon('link')}<h3>We couldn't load your internships.</h3><p>${escape(error.message)}</p><button class="button secondary" data-action="retry">Try again</button></div>`;
  }
}
function renderJobs() {
  $('#result-total').textContent = state.total.toLocaleString();
  const sortLabel = { recommended: 'Freshness + resume alignment', newest: 'Most recent postings first', match: 'Highest resume alignment first', applied: 'Most recently applied first' };
  $('#result-context').textContent = sortLabel[state.sort];
  if (!state.jobs.length) {
    const noResume = !state.data?.profile.resume;
    const running = state.data?.refresh.running;
    const applied = state.view === 'applied', saved = state.view === 'saved';
    $('#jobs').innerHTML = `<div class="empty-state">${icon(applied ? 'check' : saved ? 'bookmark' : running ? 'search' : 'spark')}<h3>${applied ? 'Your next application starts here.' : saved ? 'Keep your possibilities close.' : running ? 'Looking for your next opportunity…' : 'A little room for possibility.'}</h3><p>${applied ? "Mark a posting as Applied and it'll move here, with room for your notes." : saved ? 'Bookmark an internship to return to it later.' : running ? 'Your first search can take a few minutes. Fresh listings will appear as sources finish.' : 'No postings match this search yet. Try a wider location, another season, or fewer filters.'}</p><button class="button secondary" ${applied || saved ? 'data-action="discover"' : noResume ? 'data-open="resume"' : 'data-open="preferences"'}>${applied || saved ? 'Explore internships' : noResume ? 'Add your resume' : 'Edit preferences'} ${icon('arrow')}</button></div>`;
  } else $('#jobs').innerHTML = state.jobs.map(jobCard).join('');
  $('#pagination').innerHTML = state.pages > 1 ? `<button class="button secondary" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${state.page} of ${state.pages.toLocaleString()} · ${state.total.toLocaleString()} internships</span><button class="button secondary" data-page="${state.page + 1}" ${state.page >= state.pages ? 'disabled' : ''}>Next ${icon('chevron')}</button>` : '';
}
function jobCard(job) {
  const date = job.postedAt || job.firstSeen;
  const fresh = (Date.now() - new Date(date).getTime()) < 86400000;
  const dateLabel = job.postedAt ? job.dateBasis === 'listing' ? 'Listed' : job.dateBasis === 'estimated' ? 'Approx. posted' : 'Posted' : 'First seen';
  const termTags = job.terms.map(s => s[0].toUpperCase() + s.slice(1));
  const skills = job.match.matched.slice(0, 4);
  const other = job.match.missing.slice(0, Math.max(0, 3 - skills.length));
  return `<article class="job-card" data-job="${job.id}">
    <div class="job-top">${companyLogo(job)}<div class="job-company-title"><span class="company-name">${escape(job.company)}${!job.active ? ' · No longer in active feeds' : ''}</span><button class="job-title" data-action="details">${escape(job.title)}</button></div>${scoreMarkup(job.match)}</div>
    <div class="job-meta"><span>${icon('pin')}${escape(job.location.length > 85 ? job.location.slice(0, 82) + '…' : job.location)}</span><span>${icon('clock')}${escape(['Internship', job.timeType, job.workplaceType || (job.remote ? 'Remote' : '')].filter(Boolean).join(' · '))}</span>${job.requisitionId ? `<span>Req. ${escape(job.requisitionId)}</span>` : ''}</div>
    <div class="tag-list"><span class="tag quality-${job.match.quality}" data-quality="${job.match.quality}">${escape(job.match.qualityLabel)}</span>${(job.platforms || []).filter(k => k !== 'community').slice(0, 2).map(k => tag(platformNames[k] || k, 'platform-tag')).join('')}${termTags.map(t => tag(`${t}${job.years?.length ? ` ${job.years.join(' / ')}` : ''}`)).join('')}${skills.map(s => tag(s, 'skill')).join('')}${other.map(s => tag(s)).join('')}</div>
    ${job.description ? `<p class="job-description">${escape(job.description.slice(0, 300))}</p>` : ''}
    <div class="job-bottom"><div class="posted" title="${escape(`${dateLabel}: ${humanDate(date)}`)}">${fresh ? '<span class="fresh-label">FRESH</span>' : ''}${escape(`${dateLabel} ${relative(date).toLowerCase()}`)}${job.status === 'applied' ? `<span>Applied ${escape(relative(job.appliedAt).toLowerCase())}</span>` : ''}</div>
    <div class="job-actions">${job.status !== 'applied' ? `<button class="icon-button ${job.status === 'saved' ? 'bookmarked' : ''}" data-action="save" aria-label="${job.status === 'saved' ? 'Unsave' : 'Save'} ${escape(job.title)}" title="${job.status === 'saved' ? 'Unsave' : 'Save for later'}">${icon('bookmark')}</button>` : ''}<button class="text-button" data-action="details">View job ${icon('external')}</button>${job.status === 'applied' ? `<button class="button secondary" data-action="restore">Restore</button>` : `<button class="button secondary" data-action="apply">${icon('check')}Applied</button>`}</div></div>
  </article>`;
}
function setView(view) {
  state.view = view; state.page = 1;
  state.sort = view === 'applied' ? 'applied' : 'recommended';
  $('#sort').value = state.sort;
  $$('.nav-item[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  const labels = { new: ['Discover', 'Your next opportunity.', 'Fresh internships. Thoughtful matches. One less thing to search for.', 'For your next chapter'], saved: ['Saved', 'Possibilities worth keeping.', 'Your shortlist, ready when you are.', 'Your saved internships'], applied: ['Applied', 'Every step counts.', 'Keep track of the opportunities you’ve taken a chance on.', 'Your applications'] };
  const [label, title, subtitle, section] = labels[view];
  $('#breadcrumb-view').textContent = label; $('#page-title').textContent = title; $('#page-subtitle').textContent = subtitle; $('#results-title').textContent = section;
  $('#discover-hero').classList.toggle('hidden', view !== 'new');
  $('.sidebar').classList.remove('open');
  loadJobs();
}
function reconcileJobs() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    if (pendingJobs.size) return reconcileJobs();
    // One refresh of each resource; polling must not trigger another feed reload.
    Promise.all([loadState({ skipJobs: true }), loadJobs()]);
  }, 100);
}
function belongsToView(job, status) {
  return state.view === 'applied' ? status === 'applied' : state.view === 'saved' ? status === 'saved' : job.active && ['new', 'saved'].includes(status);
}
function feedContext() { return JSON.stringify([state.view, state.page, state.q, state.quality, state.platform, state.maxAge, state.minScore, state.sort]); }
function changeCounts(job, from, to) {
  if (!state.data || !job) return;
  const counts = state.data.counts;
  counts.active += Number(job.active && ['new','saved'].includes(to)) - Number(job.active && ['new','saved'].includes(from));
  counts.saved += Number(to === 'saved') - Number(from === 'saved');
  counts.applied += Number(to === 'applied') - Number(from === 'applied');
  renderState();
}
async function updateJob(id, status, previous, knownJob) {
  if (pendingJobs.has(id)) return;
  const job = state.jobs.find(item => item.id === id) || knownJob;
  const oldStatus = previous || job?.status || 'new';
  const index = state.jobs.findIndex(item => item.id === id), context = feedContext();
  pendingJobs.set(id, status); mutationRevision++; state.request++;
  undoAction = null; $('#toast-undo').classList.add('hidden');
  if (job) {
    changeCounts(job, oldStatus, status);
    if (index >= 0) {
      if (belongsToView(job, status)) state.jobs[index] = { ...job, status };
      else { state.jobs.splice(index, 1); state.total = Math.max(0, state.total - 1); state.pages = Math.ceil(state.total / 24); }
      renderJobs();
    }
  }
  if (state.detailId === id && $('#modal').open) $('#modal').close();
  try {
    await api(`/jobs/${id}`, { method: 'PATCH', body: { status } });
    pendingJobs.delete(id); mutationRevision++; state.request++;
    const messages = { applied: 'Moved to Applied. Here’s to the next step.', saved: 'Saved to your shortlist.', new: 'Posting restored to Discover.', hidden: 'Posting hidden from Discover.' };
    notify(messages[status], () => updateJob(id, oldStatus, status, job && { ...job, status }));
  } catch (error) {
    pendingJobs.delete(id); mutationRevision++; state.request++;
    changeCounts(job, status, oldStatus);
    if (job && context === feedContext() && index >= 0) {
      const current = state.jobs.findIndex(item => item.id === id);
      if (current >= 0) state.jobs[current] = job;
      else { state.jobs.splice(Math.min(index, state.jobs.length), 0, job); state.total++; state.pages = Math.ceil(state.total / 24); }
      renderJobs();
    }
    notify(`Change could not be saved. ${error.message}`);
  } finally { reconcileJobs(); }
}

function openModal(kind, job) {
  if (!state.data && kind !== 'about') return;
  state.modal = kind;
  clearTimeout(detailTimer); detailToken++; state.detailId = kind === 'job' ? job.id : null;
  const titles = { resume: 'Your experience, in focus.', preferences: 'Make it your search.', sources: 'A wider view of what’s out there.', about: 'A little clarity goes a long way.', job: job?.title };
  $('#modal-title').textContent = titles[kind];
  $('#modal-eyebrow').textContent = kind === 'job' ? 'THE OPPORTUNITY' : kind === 'sources' ? 'CONNECTED SOURCES' : 'YOUR WORKSPACE';
  $('#modal-content').innerHTML = kind === 'resume' ? resumeModal() : kind === 'preferences' ? preferencesModal() : kind === 'sources' ? sourcesModal() : kind === 'job' ? detailModal(job) : aboutModal();
  if (!$('#modal').open) $('#modal').showModal();
  $('#modal').scrollTop = 0;
  if (kind === 'resume') wireResume();
  if (kind === 'preferences') wirePreferences();
  if (kind === 'sources') wireSources();
  if (kind === 'job') { wireDetails(job); if (job.match.quality !== 'full' || needsWorkdayMetadata(job)) fetchDetails(job); }
}
function resumeModal() {
  const profile = state.data.profile;
  return `<p class="modal-intro">A resume helps us connect your skills with the right opportunities. Upload a file or paste your resume text or source code.</p>
    <div class="tabs" role="tablist" aria-label="Resume input"><button class="tab active" role="tab" aria-selected="true" aria-controls="upload-panel" id="upload-tab" data-tab="upload">Upload a file</button><button class="tab" role="tab" aria-selected="false" aria-controls="paste-panel" id="paste-tab" data-tab="paste">Paste text or source</button></div>
    <form id="resume-form"><div id="upload-panel" role="tabpanel" aria-labelledby="upload-tab"><div class="drop-zone" id="drop-zone">${icon('upload')}<p>Drop your resume here</p><small>PDF, DOCX, TXT, Markdown, LaTeX, HTML, JSON, JSX, or TSX · up to 4 MB</small><input type="file" name="resume" id="resume-file" aria-label="Choose resume file" accept=".pdf,.docx,.txt,.md,.tex,.html,.htm,.json,.jsx,.tsx"></div></div>
    <div id="paste-panel" class="hidden" role="tabpanel" aria-labelledby="paste-tab"><label class="field"><span>Resume text or source code</span><textarea class="resume-editor" id="resume-text" placeholder="Paste your resume here, including LaTeX or HTML source…">${escape(profile.resume)}</textarea><small>We read the text and formatting. Code is never executed.</small></label></div>
    ${profile.resume ? `<div class="resume-preview"><strong>Currently using: ${escape(profile.resumeName || 'Pasted resume')}</strong><p>${escape(profile.resume.slice(0, 800))}</p></div>` : ''}
    <div id="resume-error" class="form-error hidden" role="alert"></div><div class="modal-footer"><span>${state.data.browserOnly ? "Saved in this browser. PDFs are read in your browser; other files are parsed by Vercel. Never sent to job sites." : "Processed locally. Your resume is not sent to job sites."}</span><div class="modal-footer-actions">${profile.resume ? '<button type="button" class="text-button" id="remove-resume">Remove resume</button>' : ''}<button class="button" id="resume-submit">Save resume ${icon('arrow')}</button></div></div></form>`;
}
function formError(id, message) { const el = $(id); el.textContent = message; el.classList.remove('hidden'); }
function wireResume() {
  let tab = 'upload', droppedFile;
  $$('[data-tab]').forEach(button => button.addEventListener('click', () => {
    tab = button.dataset.tab;
    $$('[data-tab]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-selected', String(b === button)); });
    $('#upload-panel').classList.toggle('hidden', tab !== 'upload'); $('#paste-panel').classList.toggle('hidden', tab !== 'paste');
  }));
  const zone = $('#drop-zone');
  for (const event of ['dragenter', 'dragover']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add('dragover'); });
  for (const event of ['dragleave', 'drop']) zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove('dragover'); });
  zone.addEventListener('drop', event => { droppedFile = event.dataTransfer.files[0]; if (droppedFile) $('p', zone).textContent = droppedFile.name; });
  $('#resume-file').addEventListener('change', () => { droppedFile = null; });
  $('#resume-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('#resume-submit'); button.disabled = true; $('#resume-error').classList.add('hidden');
    try {
      if (tab === 'upload') {
        const file = droppedFile || $('#resume-file').files[0];
        if (!file) throw new Error('Choose a resume file or switch to Paste text or source.');
        if (file.size > 4 * 1024 * 1024) throw new Error('Choose a file under 4 MB.');
        const body = new FormData(); body.append('resume', file);
        await api('/resume', { method: 'POST', body });
      } else {
        const text = $('#resume-text').value.trim();
        if (text.length < 40) throw new Error('Paste at least 40 characters so we can understand your experience.');
        await api('/profile', { method: 'PUT', body: { resume: text, resumeName: 'Pasted resume' } });
      }
      $('#modal').close(); state.page = 1; await loadState({ refreshJobs: true }); notify('Resume saved. Your matches are ready to explore.');
    } catch (error) { formError('#resume-error', error.message); }
    finally { button.disabled = false; }
  });
  $('#remove-resume')?.addEventListener('click', async () => {
    try { await api('/profile', { method: 'PUT', body: { resume: '', resumeName: '' } }); $('#modal').close(); await loadState({ refreshJobs: true }); notify('Resume removed from your workspace.'); }
    catch (error) { formError('#resume-error', error.message); }
  });
}
function preferencesModal() {
  const p = state.data.profile;
  return `<p class="modal-intro">Tell us what matters to you. Location and timing filter your feed; preferred roles and keywords help rank your matches.</p><form id="preferences-form">
    <label class="field"><span>Preferred roles</span><input name="roles" value="${escape(p.roles)}" placeholder="Software engineering, robotics, product design"><small>Separate multiple roles with commas.</small></label>
    <label class="checkbox"><input type="checkbox" name="strictRoles" ${p.strictRoles ? 'checked' : ''}>Only show titles that include words from my preferred roles</label>
    <label class="field"><span>Locations</span><input name="locations" value="${escape(p.locations)}" placeholder="Los Angeles, California, New York"><small>Use the city, state, or country as it appears in postings. Blank means anywhere.</small></label>
    <div class="field-row"><label class="field"><span>Season</span><select name="season">${[['', 'Any season'], ['summer', 'Summer'], ['spring', 'Spring'], ['fall', 'Fall'], ['winter', 'Winter']].map(([v,l]) => `<option value="${v}" ${p.season === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="field"><span>Year</span><input name="year" type="text" inputmode="numeric" pattern="20[0-9]{2}" maxlength="4" value="${escape(p.year)}" placeholder="e.g. ${new Date().getFullYear() + 1}"></label></div>
    <label class="checkbox"><input type="checkbox" name="includeUnknown" ${p.includeUnknown ? 'checked' : ''}>Include postings that don't specify a season or year</label>
    <label class="checkbox"><input type="checkbox" name="includeRemote" ${p.includeRemote ? 'checked' : ''}>Include remote opportunities outside my selected locations</label>
    <label class="checkbox"><input type="checkbox" name="remoteOnly" ${p.remoteOnly ? 'checked' : ''}>Only show remote opportunities</label>
    <label class="field"><span>Keywords you care about</span><input name="keywords" value="${escape(p.keywords)}" placeholder="Machine learning, sustainability, embedded systems"><small>These give matching postings an extra boost.</small></label>
    <label class="field"><span>Exclude keywords</span><input name="exclude" value="${escape(p.exclude)}" placeholder="PhD, unpaid, sales"><small>Postings containing these terms will be filtered out.</small></label>
    <div id="preferences-error" class="form-error hidden" role="alert"></div><div class="modal-footer"><span>Changes apply to your existing listings immediately.</span><button class="button" type="submit">Save preferences ${icon('check')}</button></div></form>`;
}
function wirePreferences() {
  $('#preferences-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = $('button[type="submit"]', form); button.disabled = true;
    const data = new FormData(form), profile = {};
    for (const key of ['roles','locations','season','year','keywords','exclude']) profile[key] = String(data.get(key) || '').trim();
    for (const key of ['strictRoles','includeUnknown','includeRemote','remoteOnly']) profile[key] = data.has(key);
    try { await api('/profile', { method: 'PUT', body: profile }); $('#modal').close(); state.page = 1; await loadState({ refreshJobs: true }); notify('Preferences updated. Your search is a little more you.'); }
    catch (error) { formError('#preferences-error', error.message); }
    finally { button.disabled = false; }
  });
}
function sourcesModal() {
  const integration = state.data.integrations?.serpapi;
  return `<p class="modal-intro">Every manual or automatic job refresh re-fetches all enabled sources, including Greenhouse, Lever, Ashby, and Workday company boards. Newly discovered boards are checked in the same refresh. Workday uses internship categories when available and searches for internships and co-ops otherwise. Indeed and ZipRecruiter use JobSpy first, with public search and an optional search-index fallback if needed. Runway contributes public internship and co-op listings; Intern List contributes engineering listings from its US and Canada tables. Search platforms use your role and location preferences.</p>
    <div class="coverage-grid">${(state.data.coverage || []).map(c => `<div class="coverage-card"><strong>${escape(platformNames[c.kind])}</strong><span>${c.jobs.toLocaleString()} active internships</span><small>${['greenhouse', 'ashby', 'lever', 'workday'].includes(c.kind) ? `${c.total} known boards · ${c.checked} checked` : c.kind === 'runway' ? 'Public internships and co-ops · recent pages' : c.kind === 'internlist' ? 'Engineering · US and Canada · recent pages' : ['indeed', 'ziprecruiter'].includes(c.kind) ? 'JobSpy + public/index fallback' : 'Public search + optional indexed fallback'}</small>${c.searchUrl ? `<a href="${escape(c.searchUrl)}" target="_blank" rel="noopener noreferrer">Open ${c.kind === 'runway' || c.kind === 'internlist' ? 'listings' : 'search'} ${icon('external')}</a>` : ''}</div>`).join('')}</div>
    <p class="source-explanation">Coverage grows as boards are discovered; it is not a complete platform-wide index. Restricted searches keep earlier results and report the reason below.</p>
    <div class="source-filter-bar"><label class="search-box">${icon('search')}<input id="source-search" type="search" placeholder="Find a company or platform" aria-label="Find a source"></label><select id="source-kind-filter" aria-label="Filter source platform"><option value="">All platforms</option>${Object.entries(platformNames).map(([k,n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
    <div class="source-list" id="source-list">${state.data.sources.map(s => `<label class="source-row" data-kind="${escape(s.kind)}" data-search="${escape(`${s.name} ${s.token} ${s.kind}`.toLowerCase())}"><input type="checkbox" data-source="${s.id}" ${s.enabled ? 'checked' : ''} aria-label="Enable ${escape(s.name)}"><div class="source-info"><strong>${escape(s.name)}</strong><small>${escape(s.kind === 'community' ? 'Simplify & Pitt CSC internship listings' : `${platformNames[s.kind] || s.kind}${s.origin === 'platform' ? ['runway', 'internlist'].includes(s.kind) ? ' · public listings' : ' · public search' : ` · ${s.token}${s.origin === 'discovered' ? ' · auto-discovered' : ''}`}`)}</small><small class="${s.last_error ? 'source-error' : ''}">${s.last_error ? escape(s.last_error) : s.last_success ? `Checked ${escape(relative(s.last_success).toLowerCase())}${s.last_mode ? ` · ${s.last_mode === 'jobspy' ? 'JobSpy' : s.last_mode === 'indexed' ? 'search index' : 'direct public results'}` : ''}` : 'Waiting for first refresh'}</small>${s.last_warning && !s.last_error ? `<small class="source-error">${escape(s.last_warning)}</small>` : ''}</div><span class="source-count">${s.count.toLocaleString()} jobs</span></label>`).join('')}</div>
    <form id="search-index-form" class="source-add"><h3>Search-index fallback ${integration?.configured ? '· Connected' : '· Optional'}</h3><p class="source-explanation">Indeed and ZipRecruiter may block direct requests. A <a href="https://serpapi.com/google-jobs-api" target="_blank" rel="noopener noreferrer">SerpApi key</a> lets the app search Google Jobs and keep results with matching platform links. This is indexed coverage, not a direct scrape or full catalog. Only your search preferences are sent; your resume stays private. Your provider's quota and pricing apply.</p>${integration?.fromEnvironment ? '<p class="source-explanation">Key configured in the server environment.</p>' : `<label class="field"><span>SerpApi key</span><input type="password" id="serpapi-key" autocomplete="off" maxlength="256" placeholder="${integration?.configured ? 'Key saved. Enter a replacement to update.' : 'Paste your SerpApi key'}"><small>Stored in your local workspace database and never returned to the browser.</small></label><div class="form-error hidden" id="index-error" role="alert"></div><div class="modal-footer-actions"><button class="button secondary" type="submit">Save key ${icon('check')}</button>${integration?.configured ? '<button class="text-button" type="button" id="disconnect-index">Disconnect</button>' : ''}</div>`}</form>
    <form class="source-add" id="source-form"><h3>Connect another company</h3><div class="field-row"><label class="field"><span>Career board provider</span><select name="kind"><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option><option value="ashby">Ashby</option><option value="workday">Workday</option></select></label><label class="field"><span>Company name</span><input name="name" required maxlength="100" placeholder="e.g. Acme"></label></div><label class="field"><span>Board identifier or careers URL</span><input name="token" required maxlength="1000" placeholder="e.g. acme, or paste a careers URL"><small>Paste the company's public Greenhouse, Lever, Ashby, or Workday careers URL. Workday needs the full URL, including its career site. For a European Lever or Greenhouse identifier, add @eu.</small></label><div class="form-error hidden" id="source-error" role="alert"></div><button type="submit" class="button secondary">Connect source ${icon('link')}</button></form><div class="modal-footer"><span>Failed sources retry on the next refresh.</span><button class="button" id="source-refresh">Refresh sources ${icon('refresh')}</button></div>`;
}
function wireSources() {
  if (state.data.browserOnly) {
    $('.modal-intro', $('#modal')).textContent = 'Checks every enabled source while this tab is open. Paged sources retrieve recent results in bounded requests. Public search may be blocked by some sites; JobSpy and search-index subscriptions are not used. Your source catalog stays in this browser.';
    $('#search-index-form').classList.add('hidden');
    $$('.coverage-card small').forEach(el => { if (el.textContent.includes('JobSpy') || el.textContent.includes('fallback')) el.textContent = 'Public search'; });
  }
  const filter = () => {
    const query = $('#source-search').value.toLowerCase().trim(), kind = $('#source-kind-filter').value;
    $$('#source-list .source-row').forEach(row => row.classList.toggle('hidden', (!!kind && row.dataset.kind !== kind) || (!!query && !row.dataset.search.includes(query))));
  };
  $('#source-search').addEventListener('input', filter);
  $('#source-kind-filter').addEventListener('change', filter);
  $('#search-index-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); if (!button) return;
    const apiKey = $('#serpapi-key').value.trim();
    if (!apiKey) return formError('#index-error', 'Enter your key to connect. Use Disconnect to remove a saved key.');
    button.disabled = true;
    try { await api('/integrations/serpapi', { method: 'PUT', body: { apiKey } }); await loadState(); openModal('sources'); notify('Search index connected. Refresh sources to use it.'); }
    catch (error) { formError('#index-error', error.message); }
    finally { button.disabled = false; }
  });
  $('#disconnect-index')?.addEventListener('click', async () => {
    try { await api('/integrations/serpapi', { method: 'PUT', body: { apiKey: '' } }); await loadState(); openModal('sources'); notify('Search index disconnected.'); }
    catch (error) { formError('#index-error', error.message); }
  });
  $$('[data-source]').forEach(el => el.addEventListener('change', async () => {
    el.disabled = true;
    try { await api(`/sources/${el.dataset.source}`, { method: 'PATCH', body: { enabled: el.checked } }); await loadState({ refreshJobs: true }); }
    catch (error) { el.checked = !el.checked; notify(error.message); }
    finally { el.disabled = false; }
  }));
  $('#source-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button', event.currentTarget); button.disabled = true;
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/sources', { method: 'POST', body }); await loadState(); openModal('sources'); notify('Source connected. Refresh to discover its internships.'); }
    catch (error) { formError('#source-error', error.message); }
    finally { button.disabled = false; }
  });
  $('#source-refresh').addEventListener('click', () => { $('#modal').close(); startRefresh(); });
}
function detailModal(job) {
  return `<div data-job="${job.id}"><div class="detail-header">${companyLogo(job)}<div><strong>${escape(job.company)}</strong><p>${escape(job.location)}</p></div>${scoreMarkup(job.match, 'detail-score')}</div><div class="tag-list"><span id="detail-quality" class="tag quality-${job.match.quality}">${escape(job.match.qualityLabel)}</span>${job.terms.map(t => tag(t[0].toUpperCase() + t.slice(1))).join('')}${job.remote ? tag('Remote') : ''}${!job.active ? tag('No longer in active feeds') : ''}${job.status === 'applied' ? tag('Applied', 'skill') : ''}</div>
    <div class="description-status" id="detail-enrichment-status" role="status">${descriptionStatus(job)}</div>
    <div class="detail-section"><h3>Why this match?</h3><div id="detail-match-evidence">${matchEvidence(job)}</div><p>Resume alignment is an estimate of shared skills and terms, not an acceptance probability. Title-only and summary scores are provisional. Location and season preferences are applied separately.</p></div>
    <div class="detail-section" id="posting-facts">${postingFacts(job)}</div>
    <div class="detail-section"><h3>The opportunity</h3><div class="detail-description" id="detail-description">${escape(job.description || 'Only the title and location are available so far. We are looking for the full public description.')}</div></div>
    <div class="detail-dates">${job.postedAt ? `${job.dateBasis === 'listing' ? 'Listed by source' : job.dateBasis === 'estimated' ? 'Approximate posting date (from a relative source date)' : 'Published'}: ${escape(humanDate(job.postedAt, job.postedDatePrecision === 'day'))}` : 'Published date: not provided by source'}<br>First discovered: ${escape(humanDate(job.firstSeen))}<br>Last seen in a feed: ${escape(humanDate(job.lastSeen))}<br>Sources: ${escape(job.sourceNames || 'Company careers feed')}${job.appliedAt ? `<br>Applied: ${escape(humanDate(job.appliedAt))}` : ''}</div>
    <div class="detail-actions"><a class="button" href="${escape(job.url)}" target="_blank" rel="noopener noreferrer">Open original posting ${icon('external')}</a><button class="button secondary" data-detail-action="apply">${icon('check')}${job.status === 'applied' ? 'Restore to Discover' : 'Mark as Applied'}</button>${job.status !== 'applied' ? `<button class="button secondary" data-detail-action="save">${icon('bookmark')}${job.status === 'saved' ? 'Unsave' : 'Save'}</button><button class="text-button" data-detail-action="hide">Hide posting</button>` : ''}</div>
    <div class="detail-section"><h3>Your notes</h3><textarea id="job-note" class="notes-field" maxlength="10000" placeholder="A contact, application date, or something to remember…" aria-label="Application notes">${escape(job.note)}</textarea><div class="note-controls"><span>Notes are private to your workspace.</span><button class="text-button" id="save-note">Save notes ${icon('check')}</button></div></div></div>`;
}
function matchEvidence(job) {
  return `<ul class="match-reasons">${job.match.reasons.map(r => `<li>${escape(r)}</li>`).join('')}</ul><div class="tag-list">${job.match.matched.map(s => tag(s, 'skill')).join('')}${job.match.missing.map(s => tag(`${s} · not found in resume`, 'missing')).join('')}</div>`;
}
function needsWorkdayMetadata(job) {
  try { return /^[a-z\d-]+\.wd\d+\.myworkdayjobs\.com$/i.test(new URL(job.url).hostname) && !job.workdayDetailsFetchedAt; }
  catch { return false; }
}
function postingFacts(job) {
  const rows = [['Work arrangement', job.workplaceType], ['Schedule', job.timeType], ['Requisition ID', job.requisitionId],
    ['Locations', job.locations?.join(' · ')],
    ['Posted', job.postedAt ? `${job.dateBasis === 'estimated' ? 'Approx. ' : ''}${humanDate(job.postedAt, job.postedDatePrecision === 'day')}` : job.sourcePostedOn ? `${job.sourcePostedOn} (as reported when fetched)` : null]];
  return rows.filter(([, value]) => value).map(([label, value]) => `<div><strong>${escape(label)}:</strong> ${escape(value)}</div>`).join('');
}
function descriptionStatus(job, progress) {
  if (needsWorkdayMetadata(job) && job.match.quality === 'full') return ['retry','unavailable'].includes(progress?.state)
    ? `Full description available. ${escape(progress.lastError || 'Additional Workday details are temporarily unavailable.')}`
    : 'Full description available. Fetching the posting date, schedule, work arrangement, and requisition details.';
  if (job.match.quality === 'full') return `${job.descriptionMethod === 'shared' ? 'Full description shared from an unambiguous matching posting.' : 'Full description available.'}${job.descriptionUrl ? ` <a href="${escape(job.descriptionUrl)}" target="_blank" rel="noopener noreferrer">Description source ${icon('external')}</a>` : ''}${job.descriptionFetchedAt ? `<small>Retrieved ${escape(humanDate(job.descriptionFetchedAt))}</small>` : ''}`;
  if (progress?.state === 'retry' || progress?.state === 'unavailable') return `${escape(progress.lastError || 'Full details are not available yet.')}<small>Next automatic attempt: ${escape(humanDate(progress.nextAttempt))}. Your current match remains provisional.</small>`;
  return `${escape(job.match.qualityLabel)} · provisional match. ${progress?.state === 'working' ? 'Fetching the full public description…' : 'Queued for the full public description. Opening this job gives it priority.'}`;
}
async function fetchDetails(job) {
  const token = detailToken;
  const current = () => $('#modal').open && state.modal === 'job' && state.detailId === job.id && token === detailToken;
  const update = data => {
    if (!current()) return;
    if (data.job.description !== job.description || data.job.match.quality !== job.match.quality || data.job.workdayDetailsFetchedAt !== job.workdayDetailsFetchedAt) {
      Object.assign(job, data.job);
      $('#detail-description').textContent = job.description;
      $('#detail-quality').textContent = job.match.qualityLabel;
      $('#detail-quality').className = `tag quality-${job.match.quality}`;
      $('.detail-score').outerHTML = scoreMarkup(job.match, 'detail-score');
      $('#detail-match-evidence').innerHTML = matchEvidence(job);
      $('#posting-facts').innerHTML = postingFacts(job);
      $('.detail-header p').textContent = job.location;
      $('.detail-dates').innerHTML = `${job.postedAt ? `${job.dateBasis === 'estimated' ? 'Approximate posting date' : job.dateBasis === 'listing' ? 'Listed by source' : 'Published'}: ${escape(humanDate(job.postedAt, job.postedDatePrecision === 'day'))}` : 'Published date: not provided by source'}<br>First discovered: ${escape(humanDate(job.firstSeen))}<br>Last seen in a feed: ${escape(humanDate(job.lastSeen))}<br>Sources: ${escape(job.sourceNames || 'Company careers feed')}${job.appliedAt ? `<br>Applied: ${escape(humanDate(job.appliedAt))}` : ''}`;
      loadJobs();
    }
    $('#detail-enrichment-status').innerHTML = descriptionStatus(data.job, data.enrichment);
    // Update only the posting details; never replace the notes input or its unsaved draft.
    if ((data.job.match.quality !== 'full' || needsWorkdayMetadata(data.job)) && !['retry','unavailable'].includes(data.enrichment?.state)) {
      detailTimer = setTimeout(async () => {
        if (!current()) return;
        try { update(await api(`/jobs/${job.id}`)); }
        catch (error) { if (current()) $('#detail-enrichment-status').textContent = error.message; }
      }, 2000);
    }
  };
  try { update(await api(`/jobs/${job.id}/enrich`, { method: 'POST' })); }
  catch (error) { if (current()) $('#detail-enrichment-status').textContent = error.message; }
}
function wireDetails(job) {
  $$('[data-detail-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.detailAction;
    updateJob(job.id, action === 'apply' ? job.status === 'applied' ? 'new' : 'applied' : action === 'hide' ? 'hidden' : job.status === 'saved' ? 'new' : 'saved', job.status);
  }));
  $('#save-note').addEventListener('click', async () => {
    const button = $('#save-note'); button.disabled = true;
    try { await api(`/jobs/${job.id}`, { method: 'PATCH', body: { note: $('#job-note').value } }); job.note = $('#job-note').value; notify('Notes saved.'); }
    catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  });
}
function aboutModal() {
  if (state.data.browserOnly) return `<p class="modal-intro">Your personal internship workspace, saved in this browser.</p><section class="about-section"><h3>Search while you browse</h3><p>Sources are checked when you open the site and every two hours while the tab stays open. Reloading starts a fresh search using your saved source catalog. Closing the tab stops searching. Each paged source checks a limited recent window; coverage depends on accessible public pages.</p></section><section class="about-section"><h3>Your data</h3><p>Your resume, preferences, application history and notes stay in this browser's storage. PDFs are read in this browser. Other uploaded files are sent to Vercel for parsing without being saved on the server. Pasted text and matching stay in the browser. Clearing site data removes your workspace, and another device has a separate workspace. Export applications to keep a copy of your history.</p></section><section class="about-section"><h3>Matches and details</h3><p>Scores compare your skills and resume wording with postings; they are not acceptance probabilities. Incomplete descriptions produce provisional scores. Opening a supported employer posting fetches its full description and updates the score. Some sites block automated access; open the original posting for details. Marking Applied only tracks your action; submit applications on the employer site.</p></section>`;
  return `<p class="modal-intro">Internscope brings fresh opportunities and your experience into the same place.</p><section class="about-section"><h3>How your matches are calculated</h3><p>We compare recognized skills and meaningful terms in your resume with each posting. Skill coverage contributes 65% and shared terms 35% to the base score. Preferred roles and keywords adjust that score. Your recommended feed combines 72% resume alignment with 28% freshness, so new, relevant opportunities rise to the top. These percentages describe text alignment, not your chance of receiving an offer.</p></section><section class="about-section"><h3>Where opportunities come from</h3><p>Listings come from the <a href="https://github.com/SimplifyJobs/Summer2027-Internships" target="_blank" rel="noopener noreferrer">Simplify & Pitt CSC internship list</a>, company boards, public platform searches, Runway, and Intern List. You can connect more company boards in Job sources. Coverage depends on accessible sources and is not the entire internet.</p></section><section class="about-section"><h3>More detail, clearer matches</h3><p>Each posting is labeled Title only, Summary, or Full description. Scores for incomplete postings are estimates. Full descriptions load progressively in the background; opening a posting prioritizes its details and updates its score when they arrive. You can choose Full descriptions only in the Posting details filter. Some pages remain incomplete when their details are unavailable publicly.</p></section><section class="about-section"><h3>Dates that mean what they say</h3><p>“Posted” is the published date provided by a company feed. “Listed” is when a community feed added the job. When neither is available, “First seen” is when Internscope discovered it. A company's last edit is never presented as a new posting.</p></section><section class="about-section"><h3>A search that keeps moving</h3><p>Internscope checks sources every two hours while the server is running, even if this browser tab is closed. Keep the app running on an always-on computer or deploy it with persistent storage for continuous updates. Failed sources keep their last known results and retry on the next refresh.</p></section><section class="about-section"><h3>Your workspace stays yours</h3><p>Resume parsing and matching happen in this app. Your resume isn't sent to job sites or an AI service. Marking Applied records your application and moves it out of Discover; use the original posting to submit the application. Saved jobs and application notes persist in the local database.</p></section>`;
}
async function startRefresh() {
  try { const result = await api('/refresh', { method: 'POST' }); notify(result.message); await loadState({ refreshJobs: true }); }
  catch (error) { notify(error.message); }
}

document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  if (open) return openModal(open.dataset.open);
  const nav = event.target.closest('[data-view]');
  if (nav) return setView(nav.dataset.view);
  const age = event.target.closest('[data-age]');
  if (age) { state.maxAge = Number(age.dataset.age); state.page = 1; $$('[data-age]').forEach(b => b.classList.toggle('active', b === age)); return loadJobs(); }
  const page = event.target.closest('[data-page]');
  if (page && !page.disabled) { state.page = Number(page.dataset.page); loadJobs(); $('.results-area').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'retry') return loadState({ refreshJobs: true });
  if (action.dataset.action === 'discover') return setView('new');
  const job = state.jobs.find(j => j.id === action.closest('[data-job]')?.dataset.job);
  if (!job) return;
  if (action.dataset.action === 'details') return openModal('job', job);
  if (action.dataset.action === 'apply') return updateJob(job.id, 'applied', job.status);
  if (action.dataset.action === 'restore') return updateJob(job.id, 'new', job.status);
  if (action.dataset.action === 'save') return updateJob(job.id, job.status === 'saved' ? 'new' : 'saved', job.status);
});
$('#search').addEventListener('input', event => { state.q = event.target.value; state.page = 1; clearTimeout(searchTimer); searchTimer = setTimeout(loadJobs, 250); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; loadJobs(); });
$('#min-score').addEventListener('change', event => { state.minScore = Number(event.target.value); state.page = 1; loadJobs(); });
$('#platform-filter').addEventListener('change', event => { state.platform = event.target.value; state.page = 1; loadJobs(); });
$('#quality-filter').addEventListener('change', event => { state.quality = event.target.value; state.page = 1; loadJobs(); });
$('#refresh-button').addEventListener('click', startRefresh);
$('#close-modal').addEventListener('click', () => $('#modal').close());
$('#modal').addEventListener('close', () => { clearTimeout(detailTimer); detailToken++; state.detailId = null; });
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#modal').close(); } });
$('#toast-close').addEventListener('click', () => $('#toast').classList.add('hidden'));
$('#toast-undo').addEventListener('click', () => { const action = undoAction; undoAction = null; $('#toast').classList.add('hidden'); action?.(); });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
loadState({ refreshJobs: true });
window.addEventListener('internscope-update', () => loadState({ refreshJobs: true }));
