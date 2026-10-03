'use strict';

const $ = (selector) => document.querySelector(selector);
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const THEME_KEY = 'ste-prompt-engineer.theme'; // Also read by prefs.js before first paint.
const SIDEBAR_KEY = 'ste-prompt-engineer.sidebar';
const SETTINGS_KEY = 'ste-prompt-engineer.settings';
const PROJECT_PANEL_KEY = 'promptboard.project-panel';
const HISTORY_LIMIT = 500;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const KNOWN_PROVIDERS = ['codex', 'claude', 'gemini', 'agy'];
const KNOWN_DETAILS = ['super-short', 'concise', 'detailed', 'extremely-detailed'];
const KNOWN_TASKS = ['build', 'debug', 'refactor', 'review', 'architecture', 'agent-workflow', 'research'];
const LANGUAGE_NAMES = { en: 'English', de: 'Deutsch', pl: 'Polski' };
const providerInfo = {
  codex: { name: 'Codex', install: 'npm install -g @openai/codex', url: 'https://developers.openai.com/codex/cli/', signIn: 'Run codex and sign in.' },
  claude: { name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', url: 'https://code.claude.com/docs/en/setup', signIn: 'Run claude and sign in.' },
  agy: { name: 'Antigravity CLI', install: 'Install agy from the official setup guide.', url: 'https://antigravity.google/docs/getting-started?tab=cli', signIn: 'Run agy and sign in.' },
  gemini: { name: 'Gemini CLI', install: 'npm install -g @google/gemini-cli', url: 'https://geminicli.com/docs/get-started/installation/', signIn: 'Run gemini and sign in.' },
};

let token = '';
let providers = [];
let history = readHistory();
let currentId = null;
let currentResult = null;
let controller = null;
let running = false;
let copyTimer;
let catalog = null;
let modelsLoading = false;
let modelSequence = 0;
let invalidEffort = false;
let generationSequence = 0;
let progressTimer = null;
let authInfo = null;
let authBusy = false;
let authSequence = 0;
const GENERATION_CEILING_MS = 7.5 * 60 * 1000; // Above the server's 6-minute pipeline deadline.
const STAGE_LABELS = { starting: 'Starting', models: 'Checking model options', draft: 'Drafting prompt', review: 'Reviewing requirements', repair: 'Repairing confirmed issues', 'repair-review': 'Verifying repaired prompt' };

function safeText(value, max = MAX_PROMPT_BYTES) { return typeof value === 'string' ? value.slice(0, max) : ''; }

function readHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.prompt === 'string' && typeof entry.input === 'string' && entry.input.length <= 100000 && entry.prompt.length <= MAX_PROMPT_BYTES)
      .slice(0, HISTORY_LIMIT).map((entry) => ({
        id: safeText(entry.id, 80), input: entry.input, prompt: entry.prompt,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
        provider: KNOWN_PROVIDERS.includes(entry.provider) ? entry.provider : 'codex', model: safeText(entry.model, 100),
        effort: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(entry.effort) ? entry.effort : '',
        language: ['en', 'de', 'pl'].includes(entry.language) ? entry.language : 'en',
        quality: entry.quality === 'fast' ? 'fast' : 'reviewed',
        reportedModels: Array.isArray(entry.reportedModels) ? entry.reportedModels.filter(x => typeof x === 'string').map(x => x.slice(0, 100)).slice(0, 20) : [],
        detail: KNOWN_DETAILS.includes(entry.detail) ? entry.detail : 'concise',
        task: KNOWN_TASKS.includes(entry.task) ? entry.task : 'build',
        options: entry.options && typeof entry.options === 'object' ? entry.options : {}, terminology: safeText(entry.terminology, 2000),
        durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
        lint: normalizeLint(entry.lint),
        verification: normalizeVerification(entry.verification),
      }));
  } catch { return []; }
}

function normalizeLint(lint) {
  const source = lint && typeof lint === 'object' ? lint : {};
  return {
    warnings: Array.isArray(source.warnings) ? source.warnings.slice(0, 100).filter((warning) => warning && typeof warning.message === 'string').map((warning) => ({
      rule: safeText(warning.rule, 100), message: safeText(warning.message, 3000), line: Number.isFinite(warning.line) ? warning.line : null,
    })) : [],
    wordCount: Number.isFinite(source.wordCount) ? source.wordCount : null,
    sentenceCount: Number.isFinite(source.sentenceCount) ? source.sentenceCount : null,
    reviewRequired: true,
  };
}

function normalizeVerification(value) {
  if (!value || typeof value !== 'object' || !['reviewed', 'fast'].includes(value.mode)) return null;
  const automatic = value.automatic && typeof value.automatic === 'object' ? value.automatic : {};
  const review = value.review && typeof value.review === 'object' ? value.review : {};
  const nonnegative = number => Number.isFinite(number) && number >= 0 ? number : 0;
  const list = (items, convert) => Array.isArray(items) ? items.filter(item => item && typeof item === 'object').map(convert) : [];
  const automaticStatus = automatic.status === 'pass' ? 'pass' : 'issues';
  const reviewStatus = ['pass', 'issues', 'uncertain', 'unavailable', 'skipped'].includes(review.status) ? review.status : 'unavailable';
  const semanticPass = reviewStatus === 'pass' && !review.issues?.length
    && Array.isArray(review.requirements) && review.requirements.length > 0 && review.requirements.every(item => item?.status === 'covered')
    && Array.isArray(review.criteria) && review.criteria.length > 0 && review.criteria.every(item => item?.status === 'pass');
  const checksPassed = value.status === 'checks-passed' && automaticStatus === 'pass' && value.repairFailed !== true && !automatic.issues?.length && (value.mode === 'fast' ? reviewStatus === 'skipped' : semanticPass);
  return {
    status: checksPassed ? 'checks-passed' : 'needs-review', mode: value.mode,
    automatic: {
      status: automaticStatus,
      checks: list(automatic.checks, item => ({ id: safeText(item.id, 100), status: safeText(item.status, 100), ...(Number.isFinite(item.count) ? { count: nonnegative(item.count) } : {}) })),
      issues: list(automatic.issues, item => ({ rule: safeText(item.rule, 100), message: safeText(item.message), ...(typeof item.excerpt === 'string' ? { excerpt: safeText(item.excerpt) } : {}) })),
      protectedCount: nonnegative(automatic.protectedCount), matchedCount: nonnegative(automatic.matchedCount), reviewRequired: true,
    },
    review: {
      status: reviewStatus,
      requirements: list(review.requirements, item => ({ ...(typeof item.id === 'string' ? { id: safeText(item.id, 100) } : {}), sourceQuote: safeText(item.sourceQuote), promptQuote: safeText(item.promptQuote), status: ['covered', 'missing', 'changed', 'uncertain'].includes(item.status) ? item.status : 'uncertain', note: safeText(item.note) })),
      criteria: list(review.criteria, item => ({ criterion: safeText(item.criterion, 100), status: ['pass', 'issues', 'uncertain'].includes(item.status) ? item.status : 'uncertain', note: safeText(item.note) })),
      issues: list(review.issues, item => ({ category: safeText(item.category, 100), message: safeText(item.message), ...(typeof item.sourceQuote === 'string' ? { sourceQuote: safeText(item.sourceQuote) } : {}), ...(typeof item.promptQuote === 'string' ? { promptQuote: safeText(item.promptQuote) } : {}) })),
    },
    repaired: value.repaired === true, repairFailed: value.repairFailed === true, repairReasons: Array.isArray(value.repairReasons) ? value.repairReasons.filter(item => typeof item === 'string').map(item => safeText(item, 100)) : [], calls: nonnegative(value.calls), engineVersion: safeText(value.engineVersion, 100),
    stages: list(value.stages, item => ({ stage: safeText(item.stage, 100), reportedModels: Array.isArray(item.reportedModels) ? item.reportedModels.filter(model => typeof model === 'string').map(model => safeText(model, 100)) : [], durationMs: nonnegative(item.durationMs), status: safeText(item.status, 100), inputBytes: nonnegative(item.inputBytes), outputBytes: nonnegative(item.outputBytes) })),
    promptHash: safeText(value.promptHash, 200), inputHash: safeText(value.inputHash, 200), instructionsHash: safeText(value.instructionsHash, 200),
    timings: { totalMs: nonnegative(value.timings?.totalMs), modelMs: nonnegative(value.timings?.modelMs), checksMs: nonnegative(value.timings?.checksMs) },
    reviewRequired: true,
  };
}

function announce(message) { $('#announcement').textContent = message; }

// When the browser's storage is full, the oldest prompts are dropped until the rest fit. The newest
// entry is never dropped; if even that does not fit, nothing changes and a warning stays visible.
let droppedFromHistory = 0;
function persistHistory() {
  droppedFromHistory = 0;
  for (let keep = history.length; keep >= Math.min(1, history.length); keep = keep > 20 ? Math.floor(keep * 0.9) : keep - 1) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, keep)));
      droppedFromHistory = history.length - keep;
      history = history.slice(0, keep);
      $('#storage-warning').hidden = true;
      return true;
    } catch (error) {
      if (error?.name !== 'QuotaExceededError' && error?.code !== 22) break;
    }
  }
  $('#storage-warning').hidden = false;
  return false;
}

function renderHistory() {
  const query = $('#history-search').value.trim().toLowerCase();
  const filtered = history.filter((entry) => !query || `${entry.input} ${entry.prompt}`.toLowerCase().includes(query));
  $('#history-list').replaceChildren();
  $('#history-count').textContent = String(history.length).padStart(2, '0');
  $('#history-empty').hidden = filtered.length > 0;
  $('#history-empty p').textContent = query ? 'No matching prompts.' : 'No saved prompts.';
  $('#history-empty small').textContent = query ? 'Try another word or clear the search.' : 'Your finished prompts will appear here.';
  for (const entry of filtered) {
    const row = document.createElement('div');
    row.className = `history-item${entry.id === currentId ? ' active' : ''}`;
    const button = document.createElement('button');
    button.className = 'history-restore';
    button.type = 'button';
    button.setAttribute('aria-label', `Open prompt: ${entry.input.slice(0, 100)}`);
    if (entry.id === currentId) button.setAttribute('aria-current', 'true');
    const title = document.createElement('strong');
    title.textContent = entry.input.replace(/\s+/g, ' ').slice(0, 90);
    const meta = document.createElement('small');
    const date = new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    meta.textContent = `${date} · ${providerInfo[entry.provider]?.name || entry.provider}`;
    button.append(title, meta);
    button.addEventListener('click', () => restoreEntry(entry));
    button.disabled = running;
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Delete from this browser';
    remove.setAttribute('aria-label', `Delete prompt: ${entry.input.slice(0, 80)}`);
    remove.disabled = running;
    remove.addEventListener('click', () => {
      history = history.filter((item) => item.id !== entry.id);
      if (currentId === entry.id) currentId = null;
      const saved = persistHistory();
      renderHistory();
      announce(saved ? 'Prompt removed from browser history.' : 'Prompt removed from this session. Browser history changes were not saved.');
    });
    row.append(button, remove);
    $('#history-list').append(row);
  }
}

function updateCount() {
  $('#character-count').textContent = `${$('#prompt-input').value.length.toLocaleString()} / 100,000`;
}

function savePref(key, value) { try { localStorage.setItem(key, value); } catch {} }
// Collapse step 2 to focus on the request. The choice is remembered in this browser.
function setSettingsCollapsed(collapsed, save = true) {
  $('#settings-body').hidden = collapsed;
  $('#settings-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#settings-toggle').setAttribute('aria-label', collapsed ? 'Expand settings' : 'Collapse settings');
  $('#settings-toggle').title = collapsed ? 'Expand settings' : 'Collapse settings';
  $('#settings-toggle span').textContent = collapsed ? '+' : '−';
  if (save) savePref(SETTINGS_KEY, collapsed ? 'collapsed' : 'expanded');
}
// Collapse the Kanban project settings to give the board more room. Remembered in this browser.
function setProjectCollapsed(collapsed, save = true) {
  if (collapsed && $('#project-settings').contains(document.activeElement)) $('#project-toggle').focus();
  $('#project-settings').hidden = collapsed;
  $('.kanban-layout').classList.toggle('settings-open', !collapsed);
  $('#project-body').hidden = collapsed;
  $('.kanban-projects').classList.toggle('collapsed', collapsed);
  const label = collapsed ? 'Expand project settings' : 'Collapse project settings';
  $('#project-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#project-toggle').setAttribute('aria-label', label);
  $('#project-toggle').title = label;
  $('#project-toggle span').textContent = collapsed ? '+' : '−';
  $('#project-summary').hidden = !collapsed;
  if (save) savePref(PROJECT_PANEL_KEY, collapsed ? 'collapsed' : 'expanded');
  fitBoardHeight();
}

let boardFitFrame;
function fitBoardHeight(immediate = false) {
  if (typeof requestAnimationFrame !== 'function') return; // Non-visual test environments.
  const measure = () => {
    const columns = $('#kanban-columns');
    if ($('#kanban-view').hidden || columns.hidden) return;
    const dockHeight = $('#dock').getBoundingClientRect().height;
    const top = columns.getBoundingClientRect().top + window.scrollY;
    columns.style.height = `${Math.max(120, window.innerHeight - top - dockHeight - 16)}px`;
  };
  // User resizing must take effect even when the browser throttles animation frames.
  if (immediate === true) { measure(); return; }
  // Coalesce refreshes without repeatedly cancelling a frame before it can run.
  if (boardFitFrame != null) return;
  boardFitFrame = requestAnimationFrame(() => {
    boardFitFrame = null;
    measure();
  });
}
function scrollBehavior() { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth'; }
function renderTheme() { $('#theme-toggle').setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark')); }
/** Theme: 'light', 'dark', or 'system' (follows the operating system). prefs.js applies it on first paint. */
function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
  savePref(THEME_KEY, theme);
  renderTheme();
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }

// Narrow screens show history as a drawer (.open); wider screens collapse it in place (data-sidebar).
function isMobile() { return window.innerWidth <= 730; }
function syncSidebarToggle() {
  const expanded = isMobile() ? $('#sidebar').classList.contains('open') : document.documentElement.dataset.sidebar !== 'collapsed';
  $('#menu-toggle').setAttribute('aria-expanded', String(expanded));
  const what = location.hash === '#/base' ? 'Base categories' : location.hash === '#/kanban' ? 'projects' : 'prompt history';
  $('#menu-toggle').setAttribute('aria-label', expanded ? `Hide ${what}` : `Show ${what}`);
}
function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#sidebar-scrim').hidden = !open;
  syncSidebarToggle();
}
function toggleSidebar() {
  if (isMobile()) {
    const open = !$('#sidebar').classList.contains('open');
    setSidebar(open);
    if (open) (location.hash === '#/kanban' ? $('#workspace-new') : $('#new-prompt')).focus();
    return;
  }
  const collapsed = document.documentElement.dataset.sidebar !== 'collapsed';
  document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  savePref(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  syncSidebarToggle();
}

function selectedProvider() { return providers.find((provider) => provider.id === $('#provider').value); }

function updateProviderState() {
  const provider = selectedProvider();
  const available = Boolean(provider?.available);
  const availableCount = providers.filter((item) => item.available).length;
  $('#generate-button').disabled = running || authBusy || modelsLoading || invalidEffort || !available || !token;
  $('#cli-status-dot').classList.toggle('ready', availableCount > 0);
  $('#cli-status-label').textContent = availableCount ? `${availableCount} CLI${availableCount === 1 ? '' : 's'} installed` : 'Connect a CLI';
  $('#provider-note').classList.toggle('unavailable', !available);
  $('#provider-note').textContent = available
    ? `${providerInfo[provider.id]?.name || provider.name} is installed. Uses your CLI's configured account and permissions.`
    : `${providerInfo[$('#provider').value]?.name || 'This CLI'} is not available. Open “Connect a CLI” for setup.`;
}

async function loadProviders() {
  try {
    const [sessionResponse, providerResponse] = await Promise.all([fetch('/api/session', { cache: 'no-store' }), fetch('/api/providers', { cache: 'no-store' })]);
    if (!sessionResponse.ok || !providerResponse.ok) throw new Error('The local server could not report its status.');
    const session = await sessionResponse.json();
    const status = await providerResponse.json();
    token = safeText(session.token, 1000);
    providers = Array.isArray(status.providers) ? status.providers.filter((item) => item && KNOWN_PROVIDERS.includes(item.id)) : [];
    if (!token) throw new Error('The local server did not return a session token.');
    for (const option of $('#provider').options) {
      const provider = providers.find((item) => item.id === option.value);
      option.textContent = `${providerInfo[option.value].name}${provider?.available ? '' : ' · not installed'}`;
    }
    if (!selectedProvider()?.available) {
      const firstAvailable = providers.find((item) => item.available);
      if (firstAvailable) $('#provider').value = firstAvailable.id;
    }
    updateProviderState();
    loadAuth();
    loadBoard();
    if (currentPage() === 'base') baseView?.show();
    await loadModels({ model: chosenModel(), effort: $('#effort').value });
  } catch (error) {
    token = '';
    $('#cli-status-label').textContent = 'Server unavailable';
    $('#provider-note').textContent = 'Could not reach the local server. Restart the app, then reload this page.';
    $('#generate-button').disabled = true;
    announce(error.message);
  }
}

function option(value, label) {
  const item = document.createElement('option'); item.value = value; item.textContent = label; return item;
}
function chosenModel() { return $('#model').value === '__custom__' ? $('#custom-model').value.trim() : $('#model').value; }
function updateLanguage() {
  const language = $('input[name="language"]:checked').value;
  $('#language-note').textContent = language === 'en' ? 'English uses STE writing principles.' : 'Clear technical language. ASD-STE100 is an English standard. Code and identifiers stay unchanged.';
}
function updateQuality() {
  const reviewed = $('input[name="quality"]:checked').value === 'reviewed';
  $('#quality-note').textContent = reviewed
    ? 'Automatic checks and a separate model review. Usually 2 CLI calls; up to 4 only when a check confirms a lost or changed requirement. Uses more time and CLI allowance.'
    : '1 CLI call, then automatic checks. No model review or repair. Check the meaning and every requirement yourself.';
  $('#progress-note').textContent = reviewed ? 'Your CLI writes, reviews, and may revise the prompt. This can take a few minutes.' : 'Your CLI writes the prompt. Automatic checks follow.';
}
function updateEffort(preferred = '') {
  const provider = $('#provider').value;
  const model = chosenModel();
  const selected = catalog?.models?.find(item => item.id === (model || catalog.defaultModel));
  const unverified = model && !selected;
  const choices = selected?.efforts || (unverified ? ({ codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'], agy: ['low', 'medium', 'high'], gemini: [] }[provider] || []) : []);
  const defaultEffort = model ? selected?.defaultEffort : catalog?.defaultEffort;
  $('#effort').replaceChildren(option('', defaultEffort ? `CLI default (${defaultEffort})` : 'CLI default (not reported)'));
  for (const level of choices) $('#effort').append(option(level, level === 'xhigh' ? 'Extra high (xhigh)' : level[0].toUpperCase() + level.slice(1)));
  invalidEffort = Boolean(preferred && !choices.includes(preferred));
  if (invalidEffort) $('#effort').append(option(preferred, `${preferred} — unavailable; choose again`));
  $('#effort').value = preferred;
  $('#effort').disabled = running || modelsLoading || (!choices.length && !invalidEffort);
  $('#custom-model-field').hidden = $('#model').value !== '__custom__';
  $('#custom-model').required = $('#model').value === '__custom__';
  $('#effort-note').textContent = invalidEffort ? 'This saved effort is no longer supported. Select CLI default or an available level.'
    : provider === 'gemini' ? 'Gemini CLI keeps its configured thinking settings; this adapter has no per-run effort switch.'
    : unverified ? 'Custom ID: these are CLI effort options. Your CLI must validate support for this model.'
    : choices.length ? 'Effort controls reasoning, independently of prompt length. Account policy can cap the requested level.'
    : 'Effort support was not reported for this model. Your CLI keeps its configured setting.';
  updateProviderState();
}
function renderModels(model = '', effort = '') {
  const defaultName = catalog?.defaultModel;
  $('#model').replaceChildren(option('', defaultName ? `CLI default (${defaultName})` : 'CLI configured default (not reported)'));
  for (const item of catalog?.models || []) $('#model').append(option(item.id, item.name === item.id ? item.id : `${item.name} · ${item.resolvedModel || item.id}`));
  $('#model').append(option('__custom__', 'Custom model ID…'));
  const found = (catalog?.models || []).some(item => item.id === model);
  $('#model').value = model ? found ? model : '__custom__' : '';
  $('#custom-model').value = found ? '' : model;
  $('#model').disabled = running || modelsLoading;
  $('#refresh-models').disabled = running || authBusy || modelsLoading || !token;
  $('#model-note').textContent = modelsLoading ? 'Reading model options from your CLI…' : catalog?.note || 'Use CLI default or enter a custom model ID.';
  updateEffort(effort);
}
async function loadModels({ model = '', effort = '', refresh = false } = {}) {
  const sequence = ++modelSequence;
  const provider = $('#provider').value;
  catalog = null; modelsLoading = true;
  renderModels(model, effort);
  try {
    if (!token || !selectedProvider()?.available) throw new Error('Install and sign in to this CLI, then refresh models.');
    const { response, data } = await api(`/api/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=1' : ''}`, { timeoutMs: 20000 });
    if (!response.ok) throw new Error('Cannot read model options. Check your CLI, then refresh.');
    if (sequence !== modelSequence || provider !== $('#provider').value) return;
    catalog = data;
    if (refresh) runCatalogs.delete(provider);
  } catch (error) {
    if (sequence !== modelSequence) return;
    catalog = { models: [], note: error.message };
  } finally {
    if (sequence === modelSequence) { modelsLoading = false; renderModels(model, effort); }
  }
}

function settings() {
  return {
    input: $('#prompt-input').value, provider: $('#provider').value, model: chosenModel(), effort: $('#effort').value, language: $('input[name="language"]:checked').value,
    detail: $('input[name="detail"]:checked').value, task: $('#task').value, quality: $('input[name="quality"]:checked').value,
    options: { acceptanceChecks: $('#acceptance-checks').checked, planFirst: $('#plan-first').checked, edgeCases: $('#edge-cases').checked, securityReview: $('#security-review').checked },
    terminology: $('#terminology').value.trim(),
  };
}

function setRunning(value) {
  running = value;
  $('#prompt-edit').disabled = value;
  if (value) closePromptEditor();
  $('#output-card').setAttribute('aria-busy', String(value));
  $('#generation-progress').hidden = !value;
  $('#cancel-button').hidden = !value;
  $('#generate-label').textContent = value ? 'Writing and checking…' : 'Generate prompt';
  $('#cancel-button').disabled = false;
  $('#new-prompt').disabled = value;
  for (const input of $('#prompt-form').querySelectorAll('input,select,textarea')) input.disabled = value;
  $('#copy-button').disabled = value || !currentResult;
  $('#export-button').disabled = value || !currentResult;
  $('#kanban-button').disabled = value || !currentResult;
  $('#split-button').disabled = value || !currentResult;
  $('#report-button').disabled = value || !currentResult?.verification;
  $('#refresh-models').disabled = value || authBusy || modelsLoading;
  $('#model').disabled = value || modelsLoading;
  updateEffort($('#effort').value);
  renderHistory();
  renderAuth();
}

async function api(path, { method = 'GET', body, timeoutMs = 20000, signal } = {}) {
  // A plain controller keeps this compatible with every fetch implementation; the timer bounds every request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  try {
    const response = await fetch(path, { method, cache: 'no-store', signal: controller.signal,
      headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = {};
    try { data = await response.json(); } catch {}
    return { response, data: data && typeof data === 'object' ? data : {} };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); }
}

function formatElapsed(ms) { const total = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; }
function startProgress() {
  const started = Date.now();
  let polling = false;
  $('#progress-stage').textContent = STAGE_LABELS.starting;
  $('#progress-elapsed').textContent = '0:00';
  stopProgress();
  progressTimer = setInterval(async () => {
    $('#progress-elapsed').textContent = formatElapsed(Date.now() - started);
    if (polling) return;
    polling = true;
    try {
      const { data } = await api('/api/status', { timeoutMs: 3000 });
      if (progressTimer && data.busy?.kind === 'generate') $('#progress-stage').textContent = STAGE_LABELS[data.busy.stage] || 'Working';
    } catch {} finally { polling = false; }
  }, 1000);
}
function stopProgress() { clearInterval(progressTimer); progressTimer = null; }

function failureMessage(data, fallback) {
  const message = typeof data.error === 'string' ? data.error : fallback;
  const reset = typeof data.resetsAt === 'string' && !Number.isNaN(Date.parse(data.resetsAt)) ? ` The provider reports a reset at ${new Date(data.resetsAt).toLocaleString()}.` : '';
  return message + reset;
}

function closePromptEditor() {
  $('#prompt-editor').hidden = true;
  $('#prompt-edit-error').hidden = true;
}

function clearOutput() {
  closePromptEditor();
  $('#prompt-edit-actions').hidden = true;
  currentResult = null;
  $('#prompt-output').textContent = '';
  $('#prompt-output').hidden = true;
  $('#output-empty').hidden = false;
  $('#output-meta').hidden = true;
  $('#lint-review').hidden = true;
  $('#verification-status').hidden = true;
  $('#verification-report').hidden = true;
  $('#copy-button').disabled = true;
  $('#export-button').disabled = true;
  $('#kanban-button').disabled = true;
  $('#split-button').disabled = true;
  $('#report-button').disabled = true;
  $('#generation-error').hidden = true;
}

function showResult(result) {
  currentResult = result;
  closePromptEditor();
  $('#prompt-edit-actions').hidden = false;
  $('#prompt-edit').disabled = running;
  const lint = normalizeLint(result.lint);
  $('#prompt-output').textContent = result.prompt;
  $('#prompt-output').hidden = false;
  $('#output-empty').hidden = true;
  $('#output-meta').replaceChildren();
  const count = lint.wordCount ?? result.prompt.trim().split(/\s+/).length;
  const parts = [`${count.toLocaleString()} words`, providerInfo[result.provider]?.name || result.provider,
    `Model requested: ${result.model || 'CLI default'}`,
    result.reportedModels?.length ? `Models reported: ${result.reportedModels.join(', ')}` : 'Actual model not reported by CLI',
    `Effort requested: ${result.effort || 'CLI default'} (effective level not reported)`,
    LANGUAGE_NAMES[result.language || 'en'], result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '', 'Human review required'];
  for (const part of parts.filter(Boolean)) {
    const span = document.createElement('span');
    span.textContent = part;
    $('#output-meta').append(span);
  }
  $('#output-meta').hidden = false;
  $('#lint-warnings').replaceChildren();
  $('#lint-count').textContent = `${lint.warnings.length} ${lint.warnings.length === 1 ? 'note' : 'notes'}`;
  if (!lint.warnings.length) {
    const item = document.createElement('li');
    item.textContent = 'No issues found by the built-in checks. Review the wording, technical terms, and original requirements before use.';
    $('#lint-warnings').append(item);
  }
  for (const warning of lint.warnings) {
    const item = document.createElement('li');
    item.textContent = `${warning.line ? `Line ${warning.line}: ` : ''}${warning.message}`;
    $('#lint-warnings').append(item);
  }
  $('#lint-review').hidden = Boolean(result.verification);
  $('#lint-review').open = false;
  showVerification(result.verification, lint);
  $('#copy-button').disabled = running;
  $('#export-button').disabled = running;
  $('#kanban-button').disabled = running;
  $('#split-button').disabled = running;
}

function showVerification(value, lint) {
  const report = normalizeVerification(value);
  const status = $('#verification-status');
  status.hidden = false;
  status.classList.toggle('needs-review', !report || report.status !== 'checks-passed');
  $('#verification-report').hidden = !report;
  $('#report-button').disabled = running || !report;
  if (!report) {
    status.textContent = 'Draft—no verification report. Review before use.';
    return;
  }
  status.textContent = report.status !== 'checks-passed' ? 'Draft—review needed'
    : report.mode === 'fast' ? 'Automatic checks complete—model review skipped. Review before use.'
    : 'Checks complete—review before use';
  $('#verification-summary').textContent = `${report.calls} CLI ${report.calls === 1 ? 'call' : 'calls'}${report.repaired ? ` · one repair (${report.repairReasons.join(', ') || 'confirmed findings'})` : ''}`;
  const seconds = value => `${(value / 1000).toFixed(1)}s`;
  $('#verification-overview').textContent = `${report.automatic.matchedCount} of ${report.automatic.protectedCount} detected protected items matched. ${report.mode === 'reviewed' ? 'Reviewed' : 'Fast'} mode · Engine ${report.engineVersion || 'not reported'} · Total ${seconds(report.timings.totalMs)}, CLI ${seconds(report.timings.modelMs)}, checks ${seconds(report.timings.checksMs)}.`;
  $('#automatic-checks').replaceChildren();
  for (const check of report.automatic.checks) {
    const item = document.createElement('li');
    item.textContent = `${check.id.replace(/[-_]/g, ' ')}: ${check.status}${check.count === undefined ? '' : ` (${check.count})`}`;
    $('#automatic-checks').append(item);
  }
  $('#verification-issues').replaceChildren();
  const issues = [
    ...report.automatic.issues.map(item => ({ ...item, category: `Automatic · ${item.rule}` })),
    ...lint.warnings.map(item => ({ ...item, category: `Language · ${item.rule}`, message: `${item.line ? `Line ${item.line}: ` : ''}${item.message}` })),
    ...report.review.issues.map(item => ({ ...item, category: `Model review · ${item.category}` })),
  ];
  if (report.repairFailed) issues.push({ category: 'Repair', message: 'The repair call failed. The previous draft and its check results are shown.' });
  for (const issue of issues) {
    const item = document.createElement('li');
    item.append(paragraph(`${issue.category}: ${issue.message}`));
    if (issue.excerpt) item.append(quotedEvidence('Excerpt', issue.excerpt));
    if (issue.sourceQuote) item.append(quotedEvidence('Your request', issue.sourceQuote));
    if (issue.promptQuote) item.append(quotedEvidence('Engineered prompt', issue.promptQuote));
    $('#verification-issues').append(item);
  }
  $('#review-criteria').replaceChildren();
  for (const criterion of report.review.criteria) {
    const item = document.createElement('li');
    item.textContent = `${criterion.criterion.replace(/[-_]/g, ' ')}: ${criterion.status}${criterion.note ? ` — ${criterion.note}` : ''}`;
    $('#review-criteria').append(item);
  }
  if (!report.review.criteria.length) {
    const item = document.createElement('li');
    item.textContent = report.review.status === 'skipped' ? 'Skipped in Fast mode.' : 'No model review criteria available.';
    $('#review-criteria').append(item);
  }
  if (!$('#verification-issues').children.length) {
    const item = document.createElement('li');
    item.textContent = report.review.status === 'unavailable' ? 'Model review was unavailable. Check every requirement yourself.'
      : report.review.status === 'uncertain' ? 'The model review was uncertain about some items. No repair was made. Check the uncertain items yourself.'
      : report.status === 'needs-review' ? 'The checks did not establish a complete pass. Review the draft and the check statuses.'
      : 'No issues reported by these checks. This does not prove the prompt is correct.';
    $('#verification-issues').append(item);
  }
  $('#requirement-note').textContent = report.review.status === 'skipped' ? 'Fast mode skips model review. No requirement coverage claim is made.'
    : report.review.status === 'unavailable' ? 'Model review was unavailable. No requirement coverage claim is made.'
    : 'The model compared the request with the draft. Its list can miss requirements or judge them incorrectly.';
  $('#requirement-ledger').replaceChildren();
  for (const requirement of report.review.requirements) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = requirement.status[0].toUpperCase() + requirement.status.slice(1);
    item.append(label, quotedEvidence('Your request', requirement.sourceQuote));
    if (requirement.promptQuote) item.append(quotedEvidence('Engineered prompt', requirement.promptQuote));
    if (requirement.note) item.append(paragraph(requirement.note));
    $('#requirement-ledger').append(item);
  }
  $('#requirement-ledger').hidden = !report.review.requirements.length;
  $('#verification-stages').replaceChildren();
  for (const stage of report.stages) {
    const item = document.createElement('li');
    const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;
    item.textContent = `${stage.stage.replace(/[-_]/g, ' ')}: ${stage.status} · ${seconds(stage.durationMs)}${stage.inputBytes ? ` · in ${kb(stage.inputBytes)}, out ${kb(stage.outputBytes)}` : ''} · ${stage.reportedModels.length ? `models reported: ${stage.reportedModels.join(', ')}` : 'actual model not reported by CLI'}`;
    $('#verification-stages').append(item);
  }
  if (!report.stages.length) {
    const item = document.createElement('li'); item.textContent = 'Call details were not recorded.'; $('#verification-stages').append(item);
  }
  $('#verification-report').open = report.status === 'needs-review';
}

function quotedEvidence(label, text) {
  const block = document.createElement('div');
  block.className = 'report-evidence';
  const title = document.createElement('span');
  title.textContent = label;
  const quote = document.createElement('blockquote');
  quote.textContent = text;
  block.append(title, quote);
  return block;
}

function restoreEntry(entry) {
  if (running) return;
  showPromptPage();
  currentId = entry.id;
  $('#prompt-input').value = entry.input;
  $('#provider').value = entry.provider;
  loadModels({ model: entry.model || '', effort: entry.effort || '' });
  $(`input[name="language"][value="${entry.language || 'en'}"]`).checked = true;
  updateLanguage();
  $(`input[name="quality"][value="${entry.quality === 'fast' ? 'fast' : 'reviewed'}"]`).checked = true;
  updateQuality();
  $(`input[name="detail"][value="${entry.detail}"]`).checked = true;
  $('#task').value = entry.task;
  $('#acceptance-checks').checked = entry.options.acceptanceChecks !== false;
  $('#plan-first').checked = entry.options.planFirst !== false;
  $('#edge-cases').checked = entry.options.edgeCases === true;
  $('#security-review').checked = entry.options.securityReview === true;
  $('#terminology').value = entry.terminology || '';
  $('#generation-error').hidden = true;
  showResult(entry);
  updateCount();
  updateProviderState();
  renderHistory();
  setSidebar(false);
  announce('Prompt restored.');
}

function newPrompt() {
  if (running) return;
  showPromptPage();
  currentId = null;
  $('#prompt-input').value = '';
  $('input[name="language"][value="en"]').checked = true;
  updateLanguage();
  $('input[name="quality"][value="reviewed"]').checked = true;
  updateQuality();
  clearOutput();
  updateCount();
  renderHistory();
  setSidebar(false);
  $('#prompt-input').focus();
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

async function generate(event) {
  event.preventDefault();
  if (running || authBusy || modelsLoading || invalidEffort || !token || !selectedProvider()?.available) return;
  const request = settings();
  if (!request.input.trim()) { $('#prompt-input').focus(); return; }
  const previousResult = currentResult;
  $('#generation-error').hidden = true;
  $('#output-empty').hidden = true;
  $('#prompt-output').hidden = true;
  $('#output-meta').hidden = true;
  $('#lint-review').hidden = true;
  $('#verification-status').hidden = true;
  $('#verification-report').hidden = true;
  const sequence = ++generationSequence;
  const ownController = new AbortController();
  controller = ownController;
  let timedOut = false;
  const ceiling = setTimeout(() => { timedOut = true; ownController.abort(); }, GENERATION_CEILING_MS);
  setRunning(true);
  startProgress();
  announce('Your CLI is engineering the prompt.');
  let failureCode = '';
  try {
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STE-Token': token },
      body: JSON.stringify(request), signal: ownController.signal,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Your input is kept. Please try again.'); }
    // Ignore a response that belongs to an older submission.
    if (sequence !== generationSequence) return;
    if (!response.ok) {
      failureCode = typeof data.code === 'string' ? data.code : '';
      throw new Error(failureMessage(data, 'The CLI could not complete this prompt.'));
    }
    if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw new Error('Your CLI returned an empty prompt. Check its sign-in and model, then try again.');
    if (new TextEncoder().encode(data.prompt).byteLength > MAX_PROMPT_BYTES) throw new Error('The result exceeds the 2 MiB output limit. Choose a shorter detail level and try again.');
    const entry = {
      ...request, id: crypto.randomUUID(), createdAt: Date.now(), prompt: data.prompt,
      provider: KNOWN_PROVIDERS.includes(data.provider) ? data.provider : request.provider,
      model: request.model,
      reportedModels: Array.isArray(data.reportedModels) ? data.reportedModels.filter(x => typeof x === 'string').slice(0, 20) : [],
      durationMs: Number.isFinite(data.durationMs) ? data.durationMs : 0, lint: normalizeLint(data.lint), verification: normalizeVerification(data.verification),
    };
    currentId = entry.id;
    history = [entry, ...history].slice(0, HISTORY_LIMIT);
    const saved = persistHistory();
    showResult(entry);
    const resultMessage = entry.verification?.status === 'checks-passed' ? 'Checks complete. Review the prompt before use.' : 'Draft returned. Review the prompt and its check report before use.';
    const dropped = droppedFromHistory ? ` Browser storage was full, so the ${plural(droppedFromHistory, 'oldest prompt')} ${droppedFromHistory === 1 ? 'was' : 'were'} removed from history.` : '';
    announce(`${resultMessage}${saved ? dropped : ' Browser history was not saved. Copy or export this prompt and its check report to keep them.'}`);
    $('#output-card').scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  } catch (error) {
    if (sequence !== generationSequence) return;
    if (previousResult) showResult(previousResult);
    else { currentResult = null; $('#output-empty').hidden = false; }
    // The request text stays in the input box on every failure path.
    if (timedOut) {
      $('#generation-error').textContent = 'The request took too long and was stopped. Your input is kept. Try again or use Fast mode.';
      $('#generation-error').hidden = false;
    } else if (error.name === 'AbortError' || failureCode === 'ABORTED') announce('Generation canceled. Your input is kept.');
    else {
      $('#generation-error').textContent = error.message || 'Generation failed. Your input is kept. Please try again.';
      $('#generation-error').hidden = false;
      if (failureCode === 'AUTH_REQUIRED') loadAuth();
      if (!failureCode && /token|session|403/i.test(error.message || '')) await loadProviders();
    }
  } finally {
    clearTimeout(ceiling);
    if (sequence === generationSequence) {
      stopProgress();
      controller = null;
      setRunning(false);
      updateProviderState();
    }
  }
}

// CLI connection panel. Installation and sign-in are reported separately; sign-in
// actions use each CLI's own documented flow. No credentials pass through this page.
async function loadAuth() {
  const sequence = ++authSequence;
  const provider = $('#provider').value;
  if (!token) return;
  try {
    const { response, data } = await api(`/api/auth?provider=${encodeURIComponent(provider)}`, { timeoutMs: 20000 });
    if (sequence !== authSequence || provider !== $('#provider').value) return;
    authInfo = response.ok ? data : { provider, installed: Boolean(selectedProvider()?.available), state: 'unknown', capabilities: null };
    if (response.ok && typeof data.installed === 'boolean') {
      const detected = selectedProvider();
      const changed = Boolean(detected?.available) !== data.installed;
      if (detected) detected.available = data.installed;
      else providers.push({ id: provider, name: providerInfo[provider]?.name || provider, available: data.installed });
      const choice = [...$('#provider').options].find(option => option.value === provider);
      if (choice) choice.textContent = `${providerInfo[provider]?.name || provider}${data.installed ? '' : ' · not installed'}`;
      updateProviderState();
      if (changed) loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: data.installed });
    }
  } catch {
    if (sequence !== authSequence) return;
    authInfo = { provider, installed: Boolean(selectedProvider()?.available), state: 'unknown', capabilities: null };
  }
  renderAuth();
}

function renderAuth() {
  const provider = $('#provider').value;
  const info = authInfo?.provider === provider ? authInfo : null;
  const detected = selectedProvider();
  const installed = info ? info.installed === true : Boolean(detected?.available);
  const caps = info?.capabilities || {};
  $('#connection-install').textContent = !detected && !info ? 'Checking CLI…' : installed ? `CLI installed${detected?.version ? ` · ${safeText(detected.version, 60)}` : ''}` : 'CLI not installed';
  const method = typeof info?.method === 'string' && info.method ? ` (${safeText(info.method, 40)})` : '';
  $('#connection-auth').textContent = !info ? 'Sign-in: checking…'
    : !installed ? 'Sign-in: not available'
    : info.state === 'signed-in' ? `Signed in${method}${info.stale ? ' · last check' : ''}`
    : info.state === 'signed-out' ? `Signed out${info.stale ? ' · last check' : ''}`
    : caps.status === 'unsupported' ? 'Sign-in status: not reported by this CLI' : 'Sign-in status: unknown';
  const blocked = running || authBusy || !token || !installed;
  $('#auth-login').textContent = info?.state === 'signed-in' ? 'Reauthenticate' : 'Connect / Sign in';
  $('#auth-login').disabled = blocked || !info;
  $('#auth-device').hidden = !caps.device;
  $('#auth-device').disabled = blocked;
  $('#auth-logout').disabled = blocked || !info;
  $('#auth-check').disabled = running || authBusy || !token;
  $('#refresh-models').disabled = running || authBusy || modelsLoading || !token;
}

function showAuthDetail(...nodes) {
  $('#auth-detail').replaceChildren(...nodes);
  $('#auth-detail').hidden = nodes.length === 0;
}
function codeBlock(text, className = '') { const code = document.createElement('code'); code.textContent = text; if (className) code.className = className; return code; }
function detailButton(label, onClick, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (className) button.className = className;
  button.addEventListener('click', onClick); return button;
}
function detailActions(...buttons) { const row = document.createElement('div'); row.className = 'detail-actions'; row.append(...buttons); return row; }
function externalLink(href, label) {
  const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label; return link;
}

function setAuthBusy(value) { authBusy = value; renderAuth(); updateProviderState(); }

async function afterAuthChange(message) {
  setAuthBusy(false);
  await loadAuth();
  loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: true });
  if (message) announce(message);
}

async function signIn(method) {
  const provider = $('#provider').value;
  const caps = authInfo?.capabilities || {};
  const name = providerInfo[provider]?.name || 'This CLI';
  if (caps.login !== 'native') {
    // Terminal handoff: the CLI needs its own interactive terminal. Existing sign-in is not removed first.
    showAuthDetail(
      paragraph(`${name} signs in through its own interactive terminal flow. Run this command in a terminal on this computer and finish the sign-in it starts. Your current sign-in is not removed first.`),
      codeBlock(caps.loginCommand || provider),
      ...(caps.loginNote ? [paragraph(caps.loginNote)] : []),
      paragraph('Then choose Check again.'),
      detailActions(detailButton('Check again', () => { showAuthDetail(); loadAuth(); loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: true }); })),
    );
    return;
  }
  setAuthBusy(true);
  showAuthDetail(paragraph('Starting the sign-in flow in your CLI…'));
  let finished = false;
  try {
    const { response, data } = await api('/api/auth/login', { method: 'POST', body: { provider, method }, timeoutMs: 30000 });
    let operation = data.operation;
    if (!response.ok || !operation) {
      finished = true;
      showAuthDetail(paragraph(operation?.code === 'UNSUPPORTED' ? 'This CLI does not support sign-in from this app.' : failureMessage(data, 'The CLI could not start sign-in. Try the terminal command instead.'), 'kanban-error'),
        ...(caps.loginCommand ? [codeBlock(method === 'device' ? caps.deviceCommand || caps.loginCommand : caps.loginCommand)] : []));
      await afterAuthChange();
      return;
    }
    const cancel = detailButton('Cancel sign-in', () => api('/api/auth/cancel', { method: 'POST', body: {} }).catch(() => {}));
    if (operation.userCode && operation.verificationUrl) {
      showAuthDetail(paragraph('Open this page, sign in, and enter the one-time code. Keep this code private.'),
        externalLink(operation.verificationUrl, 'Open the device sign-in page ↗'), codeBlock(operation.userCode, 'auth-code'), detailActions(cancel));
    } else if (operation.authUrl) {
      showAuthDetail(paragraph('Open the sign-in page in your browser and complete sign-in. This panel updates when your CLI confirms it.'),
        externalLink(operation.authUrl, 'Open the sign-in page ↗'), detailActions(cancel));
    }
    // Poll the public operation state. The CLI owns the credentials.
    const id = operation.id;
    while (['waiting', 'starting'].includes(operation?.state)) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { ({ data: { auth: operation } } = await api('/api/status', { timeoutMs: 5000 })); } catch { continue; }
      if (operation?.id !== id) operation = { state: 'failed' };
    }
    finished = true;
    const state = operation?.state;
    showAuthDetail(paragraph(state === 'succeeded' ? `${name} confirmed the sign-in.` : state === 'cancelled' ? 'Sign-in was cancelled. Your previous sign-in state is unchanged.'
      : operation?.code === 'TIMEOUT' ? 'Sign-in timed out. Try again.' : 'Sign-in did not complete. Try again, or use the terminal command.', state === 'succeeded' || state === 'cancelled' ? '' : 'kanban-error'));
    await afterAuthChange(state === 'succeeded' ? 'Signed in. Model list refreshed.' : '');
  } catch {
    if (!finished) { showAuthDetail(paragraph('The local server did not respond. Check that the app is still running.', 'kanban-error')); await afterAuthChange(); }
  }
}

function signOut() {
  const provider = $('#provider').value;
  const caps = authInfo?.capabilities || {};
  const name = providerInfo[provider]?.name || 'This CLI';
  if (caps.logout === 'terminal') {
    showAuthDetail(paragraph(caps.logoutNote || `Sign out from ${name} in a terminal.`), codeBlock(caps.logoutCommand || ''));
    return;
  }
  if (caps.logout !== 'native') {
    showAuthDetail(paragraph(`${name} documents no sign-out command that this app can run. Sign-out is not available here.`));
    return;
  }
  // Explicit confirmation. Sign-out is shared with every tool that uses this CLI's configuration.
  showAuthDetail(
    paragraph(`Sign out of ${name}? The CLI removes its stored sign-in on this computer. Other terminals, editors, and apps that use the same ${name} configuration will also be signed out.`),
    detailActions(detailButton('Sign out', confirmSignOut, 'danger'), detailButton('Keep me signed in', () => showAuthDetail())),
  );
  async function confirmSignOut() {
    setAuthBusy(true);
    showAuthDetail(paragraph('Signing out…'));
    try {
      const { response, data } = await api('/api/auth/logout', { method: 'POST', body: { provider, confirm: true }, timeoutMs: 30000 });
      showAuthDetail(response.ok ? paragraph(`${name} is signed out.`) : paragraph(failureMessage(data, 'The CLI could not sign out. Use its terminal command.'), 'kanban-error'));
      await afterAuthChange(response.ok ? `${name} signed out.` : '');
    } catch {
      showAuthDetail(paragraph('The local server did not respond. Check that the app is still running.', 'kanban-error'));
      await afterAuthChange();
    }
  }
}

function paragraph(content, className = '') {
  const p = document.createElement('p');
  p.textContent = content;
  if (className) p.className = className;
  return p;
}

function openHelp(privacy = false) {
  const content = $('#dialog-content');
  content.replaceChildren();
  $('#dialog-heading').textContent = privacy ? 'Your work. Your browser. Your CLI.' : 'A small tool. A straightforward setup.';
  if (privacy) {
    // Facts about the current version only. Keep this in step with README "Privacy and data" and SECURITY.md.
    const section = (title, items) => {
      const heading = document.createElement('h3'); heading.className = 'dialog-subhead'; heading.textContent = title;
      const list = document.createElement('ul'); list.className = 'dialog-list';
      list.append(...items.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
      return [heading, list];
    };
    content.append(
      ...section('Saved on this computer', [
        'In this browser: your last 500 prompts and your view settings. Delete prompts in the sidebar.',
        'In the Promptboard data folder: projects, cards, agent runs and their terminal output, plans, reviews, test results, timeline notes, task worktrees, and GitHub clones.',
        'Base stores resource definitions, document revisions, agent avatars, source captures, and assignments locally. Exports include document and avatar content only when you select it.',
      ]),
      ...section('Sent to your AI provider', [
        'Compose: your request goes to the CLI you selected, which sends it to its provider.',
        'Kanban: when you approve a stage (or it starts automatically), the agent CLI gets the card text, and the plan, diff, or test commands for that stage. It works in the task worktree and sends what it reads to its provider.',
        'Base: assigned instructions and context, and selected sources for wiki generation, can go to your provider. Explicit MCP tests and documentation imports contact their configured servers.',
        'Illustrated agent avatars: clicking Generate sends your description to OpenAI Images. Preview the result and save the profile to keep it.',
        'Do not put secrets or private data in prompts or cards that you cannot share with that provider.',
      ]),
      ...section('Accounts and costs', [
        'Compose and Kanban use each CLI’s sign-in, limits, and costs. GitHub uses the GitHub CLI sign-in. Optional avatar illustrations need an OpenAI image API key in the server environment and are billed separately from CLI subscriptions.',
        'Promptboard never stores account tokens. Usage reads local CLI session files from this machine, including sessions outside Promptboard, and keeps only numeric metrics, model IDs, and tool names. Codex account limits are queried through its CLI; Claude run usage snapshots are saved locally.',
        'Compose calls: Fast 1, Reviewed 2, or 4 when a confirmed problem is repaired.',
      ]),
      ...section('What Promptboard does not do', [
        'It runs only on this computer (127.0.0.1) and has no analytics or telemetry.',
        'It pushes to GitHub only when you open or update a pull request, yourself or through an Autopilot you started.',
        'It does not include the ASD-STE100 dictionary or certify STE compliance. Checks and model reviews can be wrong, so read the result.',
      ]),
    );
  } else {
    content.append(paragraph('Install one supported CLI on the same computer, then sign in through its terminal. The workbench uses that CLI’s configured model unless you select a model. Choose a supported effort and an output language before you generate.'));
    const list = document.createElement('div');
    list.className = 'setup-list';
    for (const [id, info] of Object.entries(providerInfo)) {
      const status = providers.find((item) => item.id === id);
      const card = document.createElement('div');
      card.className = 'setup-provider';
      const heading = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = info.name;
      const state = document.createElement('span');
      state.textContent = status?.available ? 'INSTALLED' : 'NOT AVAILABLE';
      heading.append(name, state);
      const command = document.createElement('code');
      command.textContent = info.install;
      const link = document.createElement('a');
      link.href = info.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Official setup guide ↗';
      card.append(heading, command, paragraph(info.signIn), link);
      list.append(card);
    }
    content.append(list, paragraph('Restart the workbench if your PATH changes. Detection confirms the command exists; it does not verify your sign-in. CLI account limits and usage costs still apply.', 'dialog-note'));
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'reload-button';
    refresh.textContent = 'Check again';
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = 'Checking…';
      await loadProviders();
      openHelp();
    });
    content.append(refresh);
  }
  if (!$('#help-dialog').open) $('#help-dialog').showModal();
}

// All three views stay in the document. Routing does not replace forms, boards or terminals.
let baseView = null;
function currentPage() { return location.hash === '#/kanban' ? 'kanban' : location.hash === '#/base' ? 'base' : 'compose'; }
function showPage() {
  const page = currentPage();
  const kanban = page === 'kanban', base = page === 'base';
  $('#prompt-view').hidden = page !== 'compose';
  $('#kanban-view').hidden = !kanban;
  $('#base-view').hidden = !base;
  document.documentElement.dataset.page = page;
  for (const link of document.querySelectorAll('.page-nav a')) {
    if (link.getAttribute('href') === ({ compose: '#/', kanban: '#/kanban', base: '#/base' })[page]) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${({ compose: 'Compose', kanban: 'Kanban', base: 'Base' })[page]} · Promptboard`;
  $('#skip-link').setAttribute('href', base ? '#base-view' : kanban ? '#kanban-view' : '#prompt-input');
  $('#history-panel').hidden = page !== 'compose';
  $('#workspace-panel').hidden = !kanban;
  $('#base-sidebar-panel').hidden = !base;
  $('#sidebar').hidden = false;
  $('#menu-toggle').hidden = false;
  $('#sidebar').setAttribute('aria-label', base ? 'Base library' : kanban ? 'Projects' : 'Prompt history');
  $('#sidebar-scrim').setAttribute('aria-label', base ? 'Close Base categories' : kanban ? 'Close projects' : 'Close history');
  if (kanban) renderBoard();
  if (base && token) baseView?.show();
  setSidebar(false);
  window.scrollTo(0, 0);
}
function showPromptPage() { if (currentPage() !== 'compose') location.hash = '#/'; }
function basePicker(options) { return baseView?.picker(options) || document.createElement('div'); }

// Kanban (PB-01): the local app stores the board in its data folder. Seven fixed stages;
// cards move through transitions the server validates; the destination determines what runs.
const KANBAN_KEY = 'ste-prompt-engineer.kanban.v1'; // Earlier browser-only board. Moved to the app once and kept here.
const MIGRATED_KEY = `${KANBAN_KEY}.migrated`;
const SELECTED_PROJECT_KEY = 'promptboard.kanban.project';
const IMPORT_LIMIT_BYTES = 20 * 1024 * 1024;
let board = null; // The server's board view.
let boardLoading = null;
let editingCardId = null;
let projectFormMode = 'new';
let dragId = null;
let repoFormFor = null;
const repositories = new Map(); // projectId -> last branch list from the server.
const pendingMoves = new Set(); // Cards reordered locally while the server confirms the new position.
const movingTo = new Map(); // taskId -> column: a column change the server has not answered yet.
let repoPanelOpen = false;

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    historyId: safeText(source.historyId, 80), provider: KNOWN_PROVIDERS.includes(source.provider) ? source.provider : '',
    model: safeText(source.model, 100), effort: safeText(source.effort, 20),
    reportedModels: Array.isArray(source.reportedModels) ? source.reportedModels.filter(model => typeof model === 'string').map(model => model.slice(0, 100)).slice(0, 20) : [],
    language: ['en', 'de', 'pl'].includes(source.language) ? source.language : '', quality: ['reviewed', 'fast'].includes(source.quality) ? source.quality : '',
    verification: ['checks-passed', 'needs-review'].includes(source.verification) ? source.verification : 'none',
    generatedAt: Number.isFinite(source.generatedAt) ? source.generatedAt : null,
  };
}

// A detached snapshot: later card edits never touch the history entry.
function snapshotSource(result) {
  return normalizeSource({ historyId: result.id, provider: result.provider, model: result.model, effort: result.effort, reportedModels: result.reportedModels,
    language: result.language, quality: result.verification?.mode || result.quality, verification: result.verification?.status, generatedAt: result.createdAt });
}

function cardStatus(card) {
  const source = card.source;
  if (!source) return { text: 'Manual card—not checked', flag: false };
  if (card.checksOutdated) return { text: 'Edited—previous checks outdated', flag: true };
  if (source.verification === 'checks-passed') return { text: source.quality === 'fast' ? 'Automatic checks only—review before use' : 'Checks complete—review before use', flag: false };
  return { text: source.verification === 'needs-review' ? 'Draft—review needed' : 'Draft—no verification report', flag: true };
}

function sourceSummary(source) {
  return [providerInfo[source.provider]?.name, source.model || 'CLI default model', LANGUAGE_NAMES[source.language]].filter(Boolean).join(' · ');
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
function countCards(projects, key = 'tasks') { return projects.reduce((sum, project) => sum + (Array.isArray(project[key]) ? project[key].length : 0), 0); }
function boardCounts(projects, key) { return `${plural(projects.length, 'project')}, ${plural(countCards(projects, key), 'card')}`; }
// Each project has its own columns (built-in stages plus custom ones) and its own move table.
function projectColumnsOf(project = currentProject()) { return project?.columns || board?.columns || []; }
function columnTitle(id, project = currentProject()) { return projectColumnsOf(project).find(column => column.id === id)?.title || board?.columns?.find(column => column.id === id)?.title || id; }
function selectedProjectId() { try { return localStorage.getItem(SELECTED_PROJECT_KEY); } catch { return null; } }
function currentProject() { return board?.projects.find(project => project.id === selectedProjectId()) || board?.projects[0] || null; }
function findTask(id) { return currentProject()?.tasks.find(task => task.id === id) || null; }

// Mirrors the server rule: any column to any other. Only the destination column's stage may run.
// The server's transition table (TRANSITIONS in board.mjs). The UI offers only these moves.
function canMove(from, to) { return from !== to && Boolean((currentProject()?.transitions || board?.transitions)?.[from]?.includes(to)); }

function setBoardWarning(message) {
  for (const warning of document.querySelectorAll('.board-warning')) { warning.textContent = message; warning.hidden = !message; }
}

/** One board request. On success the server returns the whole board, which replaces ours. */
async function boardCall(method, path, body, timeoutMs = 60000) {
  let result;
  try { result = await api(path, { method, body, timeoutMs }); }
  catch { setBoardWarning('The app did not answer, so the change was not saved. Check that Promptboard is still running.'); throw new Error('The app did not answer. The change was not saved.'); }
  const { response, data } = result;
  if (data.board) acceptBoard(data.board);
  if (!response.ok) {
    const error = Object.assign(new Error(typeof data.error === 'string' ? data.error : 'The board request failed.'), { code: data.code, status: response.status });
    if (data.code === 'STATE_WRITE_FAILED') setBoardWarning(data.error);
    if (data.code === 'REVISION_CONFLICT' || data.code === 'NOT_FOUND') await loadBoard();
    throw error;
  }
  setBoardWarning('');
  renderBoard();
  return data;
}

/** Every state write raises the board revision. A slow older answer never replaces a newer board. */
function acceptBoard(next) { if (!board || !Number.isInteger(next?.revision) || next.revision >= board.revision) board = next; }

async function loadBoard() {
  if (!token) return;
  boardLoading ??= (async () => {
    try {
      const { response, data } = await api('/api/board', { timeoutMs: 30000 });
      if (!response.ok || !data.board) throw new Error(typeof data.error === 'string' ? data.error : 'The app could not read the board.');
      acceptBoard(data.board);
      $('#kanban-load-warning').hidden = true;
      if (board.recovery) showLoadWarning(board.recovery.restoredFromBackup
        ? 'The board file was damaged, so the last good copy was restored. The damaged file was kept in the app data folder.'
        : 'The board file was damaged and no good copy was found, so the board starts empty. The damaged file was kept in the app data folder.');
      await migrateBrowserBoard();
    } catch (error) {
      showLoadWarning(`The board could not be loaded. ${error.message}`);
    } finally { boardLoading = null; renderBoard(); }
  })();
  return boardLoading;
}

function showLoadWarning(message) { $('#kanban-load-warning').textContent = message; $('#kanban-load-warning').hidden = false; }

/** Move the earlier browser-only board into the app once. The browser copy is kept. */
async function migrateBrowserBoard() {
  let raw;
  try { raw = localStorage.getItem(KANBAN_KEY); if (raw === null || localStorage.getItem(MIGRATED_KEY)) return; } catch { return; }
  let data;
  try { data = JSON.parse(raw); } catch {
    let kept = false;
    try { localStorage.setItem(`${KANBAN_KEY}.unreadable`, raw); kept = true; } catch {}
    showLoadWarning(`The Kanban board saved in this browser could not be read, so it was not moved into the app. It stays in this browser${kept ? `, with a copy under “${KANBAN_KEY}.unreadable”` : ''}.`);
    return;
  }
  try {
    const { migrated } = await boardCall('POST', '/api/board/migrate', { board: data }, 120000);
    savePref(MIGRATED_KEY, new Date().toISOString());
    if (typeof data.selectedProjectId === 'string' && !selectedProjectId()) savePref(SELECTED_PROJECT_KEY, data.selectedProjectId);
    if (migrated.cards || migrated.projects) announce(`Moved ${plural(migrated.projects, 'project')} and ${plural(migrated.cards, 'card')} from this browser into the app. The browser copy is kept.`);
  } catch (error) {
    showLoadWarning(`Cards saved in this browser were not moved into the app yet. They stay in this browser. ${error.message}`);
  }
}

function renderBoard() {
  fitBoardHeight();
  renderProjectContext(currentProject());
  const project = currentProject();
  const tasks = project?.tasks || [];
  $('#project-select').replaceChildren(...(board?.projects || []).map(item => option(item.id, item.name)));
  if (!project) $('#project-select').append(option('', board ? 'No projects yet' : 'Loading…'));
  $('#project-select').value = project?.id || '';
  $('#project-select').disabled = !project;
  $('#project-new').disabled = !board;
  for (const id of ['#project-rename', '#project-delete', '#card-new', '#agents-open']) $(id).disabled = !project;
  $('#board-count').textContent = String(tasks.length).padStart(2, '0');
  $('#board-empty').hidden = tasks.length > 0;
  $('#board-empty-text').textContent = !board ? 'Loading the board…' : project ? 'No tasks yet.' : 'Create a project to start planning.';
  $('#board-empty-note').textContent = project ? 'Choose New card, or add a generated prompt from the Compose page. New cards start in To Do.' : 'Each project gets its own board, from To Do to Done.';
  $('#empty-prompt-link').hidden = !project;
  const timelineView = Boolean(project) && projectView() === 'timeline';
  $('#kanban-columns').hidden = !project || timelineView;
  if (timelineView) $('#board-empty').hidden = true;
  $('#timeline').hidden = !timelineView;
  $('#view-board').setAttribute('aria-selected', String(!timelineView));
  $('#view-timeline').setAttribute('aria-selected', String(timelineView));
  $('#view-timeline').disabled = !project;
  for (const id of ['#autopilot-open', '#columns-open', '#agents-open', '#board-left', '#board-right', '#card-new']) $(id).hidden = timelineView;
  $('#columns-open').disabled = !project;
  if (project?.workflowMode === 'pipeline') $('#autopilot-open').hidden = true;
  // Missing terminal support never blocks the board or the prompt editor; it only disables runs.
  $('#execution-status').hidden = !board || board.execution?.available !== false || !board.execution.setupMessage;
  $('#execution-status').textContent = board?.execution?.setupMessage ? `Agent runs are unavailable. ${board.execution.setupMessage}` : '';
  const columns = $('#kanban-columns');
  const focusedCard = document.activeElement?.closest('.kanban-card');
  const focusedDisplay = document.activeElement?.dataset.cardDisplay;
  const confirming = [...columns.querySelectorAll('.kanban-card:has(.kanban-confirm)')].map(item => item.dataset.id);
  const confirmationFocus = document.activeElement?.closest('.kanban-confirm') ? document.activeElement.textContent : null;
  const scroll = new Map(columns.dataset.projectId === project?.id ? [...columns.querySelectorAll('.kanban-cards')].map(list => [list.dataset.column, list.scrollTop]) : []);
  columns.replaceChildren(...(project ? projectColumnsOf(project).map(column => renderColumn(column, tasks.filter(task => task.column === column.id))) : []));
  columns.dataset.projectId = project?.id || '';
  for (const id of confirming) {
    const item = cardElement(id), card = tasks.find(task => task.id === id);
    if (item && card) confirmCardDelete(item, card, false);
  }
  if (confirmationFocus && focusedCard) [...(cardElement(focusedCard.dataset.id)?.querySelectorAll('.kanban-confirm button') || [])].find(button => button.textContent === confirmationFocus)?.focus({ preventScroll: true });
  if (focusedCard && focusedDisplay) [...(cardElement(focusedCard.dataset.id)?.querySelectorAll('[data-card-display]') || [])].find(input => input.dataset.cardDisplay === focusedDisplay)?.focus({ preventScroll: true });
  for (const list of columns.querySelectorAll('.kanban-cards')) list.scrollTop = scroll.get(list.dataset.column) || 0;
  renderRepository(project);
  const branch = project?.targetBranch?.name;
  $('#project-summary').textContent = project ? [project.name, project.repository ? project.repository.root.split(/[\\/]/).pop() + (branch ? ` → ${branch}` : '') : 'Not linked', workflowSummary(project)].join(' · ') : '';
  $('#project-summary').title = $('#project-summary').textContent;
  // Without a project the settings are the only way forward, so they stay open.
  if (!project && $('#project-body').hidden) setProjectCollapsed(false, false);
  renderWorkspace(project);
  renderAgents(project);
  renderAutopilotBar(project);
  if (timelineView) { $('#autopilot-bar').hidden = true; refreshTimeline(project); }
  updateBoardScroll();
  window.PromptboardDock?.sync();
  const verifying = tasks.find(task => task.evidence?.tests?.status === 'running');
  if (verifying) pollTests(verifying.id);
}

// Stage icons (24×24 outline paths). Each column's colour comes from CSS (--stage).
const STAGE_ICONS = {
  todo: ['M12 3 3 8l9 5 9-5-9-5Z', 'm3 12.5 9 5 9-5', 'm3 17 9 5 9-5'],
  planning: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z', 'M9 4v14', 'M15 6v14'],
  executing: ['M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z', 'm7 9 3 3-3 3', 'M13 15h4'],
  code_review: ['m8 7-5 5 5 5', 'm16 7 5 5-5 5', 'm13.5 4-3 16'],
  testing: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3', 'M7.5 15h9'],
  merge: ['M7 7v14', 'M7 9c0 3.3 2.7 6 6 6h2', 'M9 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'M19 15a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'],
  done: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'm8 12 3 3 5-6'],
  // Done column parts.
  drop: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
  completed: ['M9 3h6v4H9z', 'M9 5H6v16h12V5h-3', 'M9 12h6', 'M9 16h4'],
  expand: ['M15 3h6v6', 'm21 3-7 7', 'M9 21H3v-6', 'm3 21 7-7'],
  custom: ['M4 6h16', 'M4 12h16', 'M4 18h10']
};
function stageIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'kanban-stage-icon' })) svg.setAttribute(name, value);
  for (const d of STAGE_ICONS[id] || STAGE_ICONS.custom) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

function renderColumn(column, tasks) {
  const section = document.createElement('section');
  section.className = `kanban-column${column.custom ? ' custom' : ''}${column.color ? ` col-${column.color}` : ''}`;
  section.dataset.column = column.id;
  const heading = document.createElement('h3');
  heading.id = `column-${column.id}`;
  heading.append(stageIcon(column.id), column.title);
  const count = document.createElement('span');
  count.className = 'kanban-count kanban-column-count';
  count.textContent = String(tasks.length);
  count.setAttribute('aria-label', `${tasks.length} ${tasks.length === 1 ? 'card' : 'cards'}`);
  const header = document.createElement('div');
  header.className = 'kanban-column-heading';
  header.append(heading, count);
  if (column.agent) {
    const settings = currentProject()?.effectiveWorkflow?.[column.id];
    const agent = detailButton(`Agent: ${agentText(settings)}`, () => openWorkflowDialog(column.id), 'column-agent');
    agent.setAttribute('aria-label', `Choose provider and model for ${column.title}`);
    agent.title = `${agentText(settings)} · ${settings?.agentSource || 'default'} setting`;
    header.append(agent);
  }
  const policy = currentProject()?.effectiveWorkflow?.[column.id]?.policy;
  const note = paragraph(column.custom ? (column.description || (column.agent ? (policy === 'manual' ? 'Custom column · agent from the card' : 'Custom column · agent starts on arrival') : 'Custom column · never runs an agent'))
    : !column.agent ? (column.id === 'todo' ? 'Never runs an agent' : 'Finished · never runs an agent')
    : !board.execution?.available ? 'Agent stage · agent terminals not set up'
    : column.id === 'merge' ? (policy === 'start' ? 'Merges automatically when verified' : 'One click merges when verified')
    : policy === 'manual' ? 'Manual · start from the card' : column.id === 'planning' ? 'Plan Mode · read-only' : column.id === 'testing' ? 'Testing agent starts on arrival' : 'Starts when a card arrives', 'kanban-column-note');
  if (currentProject()?.workflowMode === 'pipeline') note.textContent = column.role === 'todo' ? 'Stops the agent · resets its session' : column.role === 'done' ? 'Pauses the agent · archives the task'
    : column.description || (policy === 'manual' ? 'Start from the card · existing agent keeps running' : 'Starts or resumes on arrival · existing agent keeps running');
  const list = document.createElement('ol');
  list.className = 'kanban-cards';
  list.dataset.column = column.id;
  list.setAttribute('aria-labelledby', heading.id);
  const done = column.role === 'done' || (!column.role && column.id === 'done');
  list.append(...(done ? renderDoneList(tasks) : tasks.map((task, index) => renderCard(task, index, tasks.length))));
  // Dropping on empty column space puts the card at the end of that column. All of Done is one drop zone.
  const accepts = event => dragId && (done || event.target === list) && (findTask(dragId)?.column === column.id || canMove(findTask(dragId)?.column, column.id));
  list.addEventListener('dragover', event => { if (accepts(event)) { event.preventDefault(); list.classList.add('drop-target'); } });
  list.addEventListener('dragleave', event => { if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target'); });
  list.addEventListener('drop', event => {
    if (!accepts(event)) return;
    event.preventDefault();
    const id = dragId; dragId = null;
    placeCard(id, column.id, tasks.filter(task => task.id !== id).length);
  });
  section.append(header, note, list);
  if (column.id === 'todo') {
    const add = detailButton('Add task', () => openCard(null, true), 'secondary-button kanban-add-task');
    section.append(add);
  }
  return section;
}

// Done: a drop zone, then the most recently completed cards in a compact form.
const DONE_PREVIEW = 5;
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function timeAgo(at) {
  const seconds = (at - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
function renderDoneList(tasks) {
  const zone = document.createElement('li');
  zone.className = 'kanban-done-drop';
  zone.append(stageIcon('drop'), paragraph('Complete from Testing or Merge · no merge'));
  if (!tasks.length) return [zone];
  // Card numbers follow creation order within the project, so they stay stable.
  const numbers = new Map([...currentProject().tasks].sort((a, b) => a.createdAt - b.createdAt).map((task, index) => [task.id, index + 1]));
  const finished = task => task.completion?.at || task.updatedAt || 0;
  const recent = [...tasks].sort((a, b) => finished(b) - finished(a));
  const viewAll = () => openDoneDialog(recent, numbers);
  const head = document.createElement('li');
  head.className = 'kanban-done-head';
  const expand = detailButton('', viewAll, 'kanban-done-expand');
  expand.append(stageIcon('expand'));
  expand.setAttribute('aria-label', `View all ${tasks.length} completed cards`);
  head.append(stageIcon('completed'), document.createTextNode(`Completed (${tasks.length})`), expand);
  const all = document.createElement('li');
  const button = detailButton('View all', viewAll, 'kanban-done-all');
  const count = document.createElement('span');
  count.className = 'kanban-done-all-count';
  count.textContent = String(tasks.length);
  button.prepend(stageIcon('expand'));
  button.append(count);
  button.setAttribute('aria-label', `View all ${tasks.length} completed cards`);
  all.append(button);
  return [zone, head, ...recent.slice(0, DONE_PREVIEW).map(task => renderDoneCard(task, numbers.get(task.id))), all];
}
function openDoneDialog(recent, numbers) {
  $('#done-dialog-project').textContent = `${currentProject()?.name || ''} · Done`.toUpperCase();
  $('#done-dialog-heading').textContent = `Completed (${recent.length})`;
  $('#done-dialog-list').replaceChildren(...recent.map(task => renderDoneCard(task, numbers.get(task.id), false)));
  $('#done-dialog').showModal();
}
function renderDoneCard(card, number, draggable = true) {
  const item = document.createElement('li');
  item.className = 'kanban-card kanban-done-card';
  item.dataset.id = card.id;
  const title = document.createElement('div');
  title.className = 'kanban-done-title';
  const open = detailButton(card.title, () => { $('#done-dialog').close(); openCard(card.id); }, 'kanban-open');
  open.title = card.title;
  const tag = document.createElement('span');
  tag.className = 'kanban-done-number';
  tag.textContent = `#${number}`;
  title.append(open, tag);
  const when = card.completion?.at || card.updatedAt;
  const time = paragraph(when ? timeAgo(when) : '', 'kanban-done-time');
  if (when) time.title = new Date(when).toLocaleString();
  const reopen = labelledButton(detailButton('Reopen', () => reopenCard(card), 'text-button kanban-reopen'), `Reopen: ${card.title}`);
  reopen.title = 'Start a new cycle in To Do. The history, commits, and completion stay.';
  let restore = null;
  if (currentProject()?.workflowMode === 'pipeline') {
    reopen.textContent = 'Restore to To Do'; reopen.title = 'Restore without starting an agent.';
    restore = document.createElement('select'); restore.className = 'kanban-move-to kanban-restore'; restore.setAttribute('aria-label', `Restore to column: ${card.title}`);
    restore.append(option('', 'Restore to…'), ...projectColumnsOf().filter(column => column.role === 'active').map(column => option(column.id, column.title)));
    restore.addEventListener('change', async () => { if (restore.value) await placeCard(card.id, restore.value); });
  }
  const details = detailButton('Details', () => { $('#done-dialog').close(); openTaskDetails(card.id); }, 'text-button kanban-details');
  const summary = card.completion?.summary || card.prompt;
  const more = document.createElement('div'); more.className = 'kanban-more'; more.id = `card-more-${card.id}${draggable ? '' : '-completed'}`; more.hidden = cardElement(card.id)?.querySelector('.kanban-more')?.hidden ?? true;
  const edit = detailButton('Edit task', () => { $('#done-dialog').close(); openCard(card.id); }, 'kanban-edit');
  const copy = detailButton('Copy prompt', () => copyCard(card, copy), 'kanban-copy');
  more.append(edit, details, reopen, copy, detailButton('Duplicate', () => duplicateCard(card.id), 'kanban-duplicate'), detailButton('Delete', () => confirmCardDelete(item, card), 'kanban-delete'));
  if (restore) more.prepend(restore);
  const actions = document.createElement('div'); actions.className = 'kanban-actions'; actions.append(cardMenuToggle(card, more));
  title.append(actions);
  cardAppearance(item, card, more);
  item.append(title, paragraph(summary.slice(0, 200).replace(/\s+/g, ' ').trim(), 'kanban-done-preview'), time, more);
  return item;
}

function labelledButton(button, label) { button.setAttribute('aria-label', label); return button; }
/** Done → To Do. A new cycle; earlier completions, commits, reviews, tests, and runs are kept. */
async function reopenCard(card) {
  try { await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/reopen`, { expectedRevision: card.revision }); }
  catch (error) { showBoardError(error); return; }
  if ($('#done-dialog').open) $('#done-dialog').close();
  announce(`Reopened “${card.title}” in To Do. Its history is kept.`);
}

function makeDraggable(item, card) {
  item.draggable = true;
  item.addEventListener('dragstart', event => {
    dragId = card.id;
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.title); }
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    dragId = null;
    for (const element of document.querySelectorAll('.kanban-card.dragging, .drop-target')) element.classList.remove('dragging', 'drop-target');
  });
}

function latestRun(taskId) { return board.runs.filter(run => run.taskId === taskId).at(-1) || null; }

// Card display preferences are local to this browser; task content remains server-backed.
function cardAppearance(item, card, more) {
  const key = `promptboard.card-appearance.${card.id}`;
  let prefs = {};
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    for (const field of ['preview', 'agent', 'comfortable']) if (typeof stored?.[field] === 'boolean') prefs[field] = stored[field];
  } catch {}
  const values = () => ({ preview: prefs.preview ?? (uiPref('cardPreview') === '1'), agent: prefs.agent ?? (uiPref('cardAgent') === '1'), comfortable: prefs.comfortable ?? (uiPref('cardSpacing') === '1') });
  const apply = () => {
    const value = values();
    item.classList.toggle('hide-preview', !value.preview);
    item.classList.toggle('show-agent', value.agent);
    item.classList.toggle('comfortable', value.comfortable);
    for (const input of more.querySelectorAll('[data-card-display]')) input.checked = value[input.dataset.cardDisplay];
  };
  apply();
  const settings = document.createElement('details'); settings.className = 'card-appearance';
  const summary = document.createElement('summary'); summary.textContent = 'Card display';
  settings.open = Boolean(cardElement(card.id)?.querySelector('.card-appearance')?.open);
  settings.append(summary);
  for (const [field, text] of [['preview', 'Show prompt preview'], ['agent', 'Show agent information'], ['comfortable', 'Comfortable spacing']]) {
    if (field === 'agent' && card.column === 'done') continue;
    const label = document.createElement('label'); label.className = 'check-row';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.cardDisplay = field; input.checked = values()[field];
    input.addEventListener('change', () => {
      prefs[field] = input.checked; apply();
      try { localStorage.setItem(key, JSON.stringify(prefs)); }
      catch { announce('Card display changed, but this browser could not save it.'); }
    });
    label.append(input, text); settings.append(label);
  }
  settings.append(detailButton('Use display defaults', () => {
    prefs = {}; apply();
    try { localStorage.removeItem(key); } catch { announce('Defaults applied, but this browser could not save the change.'); }
  }, 'card-display-reset'), paragraph('Overrides saved for this card in this browser.', 'note'));
  more.append(settings);
}

function cardMenuToggle(card, more) {
  const toggle = labelledButton(detailButton('⋯', () => {
    more.hidden = !more.hidden;
    toggle.setAttribute('aria-expanded', String(!more.hidden));
  }, 'kanban-more-toggle'), `More actions: ${card.title}`);
  toggle.title = 'Edit, configure, and manage task';
  toggle.setAttribute('aria-expanded', String(!more.hidden));
  toggle.setAttribute('aria-controls', more.id);
  more.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); more.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
  });
  return toggle;
}

function renderCard(card, index, count) {
  const status = cardStatus(card);
  const item = document.createElement('li');
  item.className = `kanban-card${status.flag ? ' needs-review' : ''}`;
  item.dataset.id = card.id;
  const badge = document.createElement('span');
  badge.className = 'kanban-status';
  badge.textContent = status.text;
  const heading = document.createElement('h4');
  heading.append(detailButton(card.title, () => openCard(card.id), 'kanban-open'));
  const labelled = (element, label) => { element.setAttribute('aria-label', label); return element; };
  const up = labelled(detailButton('↑', () => moveWithin(card.id, -1), 'kanban-move kanban-move-up'), `Move up: ${card.title}`);
  const down = labelled(detailButton('↓', () => moveWithin(card.id, 1), 'kanban-move kanban-move-down'), `Move down: ${card.title}`);
  up.disabled = index === 0;
  down.disabled = index === count - 1;
  const moveTo = labelled(document.createElement('select'), `Move to stage: ${card.title}`);
  moveTo.className = 'kanban-move-to';
  moveTo.append(option('', 'Move to…'), ...projectColumnsOf().filter(column => canMove(card.column, column.id)).map(column => option(column.id, column.title)));
  moveTo.addEventListener('change', () => { if (moveTo.value) placeCard(card.id, moveTo.value, null); });
  const copy = labelled(detailButton('Copy prompt', () => copyCard(card, copy), 'kanban-copy'), `Copy prompt: ${card.title}`);
  // Less frequent actions sit behind "⋯" so each card stays short and a column shows more cards.
  const more = document.createElement('div');
  more.className = 'kanban-more';
  more.id = `card-more-${card.id}`;
  more.hidden = cardElement(card.id)?.querySelector('.kanban-more')?.hidden ?? true;
  const reorder = document.createElement('div'); reorder.className = 'card-reorder'; reorder.append('Order ', up, down);
  more.append(labelled(detailButton('Edit task', () => openCard(card.id), 'kanban-edit'), `Edit task: ${card.title}`), moveTo, copy, reorder,
    labelled(detailButton('Duplicate', () => duplicateCard(card.id), 'kanban-duplicate'), `Duplicate: ${card.title}`),
    labelled(detailButton('Delete', () => confirmCardDelete(item, card), 'kanban-delete'), `Delete: ${card.title}`));
  const toggle = cardMenuToggle(card, more);
  const actions = document.createElement('div');
  actions.className = 'kanban-actions';
  actions.append(toggle);
  const details = [card.source ? `Prompt source: ${sourceSummary(card.source)}` : 'Written by you'];
  if (card.workspace) details.push(`Branch ${card.workspace.branch}${card.workspace.status === 'ready' ? '' : ` (${card.workspace.status})`}`);
  const pullRequest = card.evidence?.pullRequest;
  if (pullRequest?.url) details.push(`PR ${pullRequest.number ? `#${pullRequest.number}` : ''} · ${String(pullRequest.state || 'open').toUpperCase()}`);
  const run = latestRun(card.id);
  const ap = currentProject()?.autopilot;
  const tags = [];
  if (ap && ap.status !== 'off' && (ap.current?.taskId === card.id || (ap.queue.includes(card.id) && !(ap.done || []).includes(card.id) && card.column === 'todo'))) {
    const tag = document.createElement('span');
    const waiting = ap.queue.filter(id => !(ap.done || []).includes(id) && id !== ap.current?.taskId);
    tag.className = `autopilot-tag${ap.current?.taskId === card.id ? ' now' : ''}`;
    tag.textContent = ap.current?.taskId === card.id ? 'Autopilot · now' : `Autopilot · #${waiting.indexOf(card.id) + 1}`;
    tags.push(tag);
  }
  const meta = paragraph(details.join(' · '), 'kanban-meta');
  meta.title = meta.textContent;
  const context = document.createElement('details'); context.className = 'card-workspace';
  context.open = Boolean(cardElement(card.id)?.querySelector('.card-workspace')?.open);
  const summary = document.createElement('summary'); summary.textContent = card.workspace ? 'Files and context' : 'Prompt context';
  context.append(summary, meta);
  context.append(badge);
  if (card.workspace || card.completion?.kind === 'merged') context.append(taskLocation(card, currentProject()));
  const header = document.createElement('div'); header.className = 'task-card-header'; header.append(heading, actions);
  const controls = renderRunControls(card, run);
  const agentInfo = document.createElement('div'); agentInfo.className = 'card-agent-info';
  agentInfo.append(...controls.querySelectorAll('.run-agent'));
  // Secondary actions remain available through the menu; urgent controls stay on the card.
  more.append(...controls.querySelectorAll('.kanban-details, .kanban-pr'));
  if (stageVerb(card.column)) more.append(detailButton('Column agent settings', () => openWorkflowDialog(card.column), 'kanban-configure'));
  if (run && agentState(run) === 'active') context.append(...controls.querySelectorAll('.run-activity:not([class*="flow-"])'));
  more.append(context);
  cardAppearance(item, card, more);
  item.append(header, ...tags, paragraph(card.prompt.slice(0, 400).replace(/\s+/g, ' ').trim(), 'kanban-preview'), controls, agentInfo, more);
  if (pendingMoves.has(card.id)) item.classList.add('pending');
  if (movingTo.has(card.id)) { item.classList.add('moving'); item.prepend(paragraph(`Moving to ${columnTitle(movingTo.get(card.id))}…`, 'moving-to')); }
  // Selecting a card reveals its agent session, if it has one.
  item.addEventListener('click', event => { if (!event.target.closest('button, select, a')) window.PromptboardDock?.reveal(card.id); });
  // Pointer drag-and-drop. The ↑/↓ buttons and the stage menu are the keyboard equivalent.
  makeDraggable(item, card);
  item.addEventListener('dragover', event => { if (!dragId || dragId === card.id) return; event.preventDefault(); item.classList.add('drop-target'); });
  item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
  item.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    const id = dragId; dragId = null;
    if (id && id !== card.id) placeCard(id, card.column, index);
  });
  return item;
}

function cardElement(id) { return Array.from($('#kanban-columns').querySelectorAll('.kanban-card')).find(item => item.dataset.id === id); }

function showBoardError(error) {
  showProjectDetail(paragraph(error.message, 'kanban-error'));
  announce(error.message);
}

/**
 * Move a card to a column position. Drag-and-drop, the ↑/↓ buttons, and the stage menu all use
 * this one path and the same server transition. The card moves at once and shows as pending;
 * a rejected move is rolled back visibly with the reason. `index` counts the other cards in
 * that column; null means the end.
 */
const newTransitionId = () => globalThis.crypto?.randomUUID?.() || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/**
 * Move a card. Drag-and-drop, the stage menu, and the task-details buttons all use this.
 * A column change shows the card as "Moving to …" in its current column until the server
 * answers: the card enters the new column only when the server accepted the move (and the
 * stage started), or the server asks for one approval first. Reordering within a column is shown at once.
 */
async function placeCard(id, column, index, retried = false) {
  const card = findTask(id);
  if (!card || pendingMoves.has(id) || movingTo.has(id)) return false;
  const project = currentProject();
  const others = project.tasks.filter(task => task.column === column && task.id !== id);
  const position = index === null ? others.length : Math.min(index, others.length);
  const reorder = column === card.column;
  if (!reorder && !canMove(card.column, column)) {
    showMoveError(card, column, Object.assign(new Error(card.column === 'done' ? 'A card in Done moves only with Reopen.' : `Allowed from ${columnTitle(card.column)}: ${((currentProject()?.transitions || {})[card.column] || []).map(id => columnTitle(id)).join(', ') || 'none'}.`), { code: 'TRANSITION_NOT_ALLOWED' }));
    return false;
  }
  const snapshot = project.tasks.slice();
  if (reorder) {
    const rest = project.tasks.filter(task => task.id !== id);
    const before = rest.filter(task => task.column === column)[position];
    const at = before ? rest.indexOf(before) : (others.length ? rest.indexOf(others.at(-1)) + 1 : rest.length);
    rest.splice(at, 0, card);
    project.tasks = rest;
    pendingMoves.add(id);
  } else movingTo.set(id, column);
  renderBoard();
  let result;
  try {
    result = await boardCall('POST', `/api/tasks/${encodeURIComponent(id)}/move`, { column, index: position, expectedRevision: card.revision, transitionId: newTransitionId() }, 180000);
  } catch (error) {
    pendingMoves.delete(id); movingTo.delete(id);
    // Background work (for example test results) can change a card's revision. If the card is still
    // where the user saw it, the move they asked for is unchanged: reload and try once more.
    if (error.code === 'REVISION_CONFLICT' && !retried && findTask(id)?.column === card.column) return placeCard(id, column, index, true);
    if (reorder && currentProject()?.id === project.id && error.code !== 'REVISION_CONFLICT' && error.code !== 'NOT_FOUND') currentProject().tasks = snapshot;
    renderBoard();
    cardElement(id)?.classList.add('rejected');
    showMoveError(card, column, error);
    return false;
  }
  pendingMoves.delete(id); movingTo.delete(id);
  renderBoard();
  movedAnnouncement(card, column, result, reorder ? `position ${position + 1} of ${others.length + 1}` : '');
  return true;
}

function movedAnnouncement(card, column, result, position = '') {
  if (position) { announce(`Moved “${card.title}” to ${position}.`); return; }
  if (result.duplicate) return;
  if (result.run) { announce(`Moved “${card.title}” to ${columnTitle(column)} and started the ${columnTitle(column)} agent.`); showStartedRun(result.run.id); }
  else if (result.tests) { announce(`Moved “${card.title}” to Testing. The project's tests are running.`); pollTests(card.id); }
  else if (result.merge && !result.merged) announce(`Moved “${card.title}” to Merge. ${result.merge.message}`);
  else if (result.task?.column === 'done') announce(`“${card.title}” is done: ${result.merged ? `merged into ${result.task.completion?.targetBranch || 'the target branch'}` : 'saved without merging; the task branch is kept'}.`);
  else announce(`Moved “${card.title}” to ${columnTitle(column)}. Nothing was started.`);
}

function showMoveError(card, column, error) {
  const message = `“${card.title}” stayed in ${columnTitle(card.column)}. ${error.message}`;
  if (error.code !== 'RUN_ACTIVE') { showBoardError(Object.assign(new Error(message), { code: error.code })); return; }
  // Moving an active card needs the run stopped first, with confirmation.
  const run = activeRun(card.id);
  const stop = detailButton('Stop the agent and move', async () => {
    try { await boardCall('POST', `/api/runs/${encodeURIComponent(run.id)}/cancel`, { confirm: true }); }
    catch (failure) { showBoardError(failure); return; }
    showProjectDetail(paragraph('Stopping the agent…'));
    for (let tries = 0; tries < 50 && activeRun(card.id); tries++) { await new Promise(resolve => setTimeout(resolve, 200)); await loadBoard(); }
    showProjectDetail();
    placeCard(card.id, column, null);
  }, 'danger');
  showProjectDetail(paragraph(message), detailActions(stop, detailButton('Keep it running', () => showProjectDetail())));
  announce(message);
}

async function moveWithin(id, step) {
  const card = findTask(id);
  if (!card) return;
  const column = currentProject().tasks.filter(task => task.column === card.column);
  if (!await placeCard(id, card.column, column.indexOf(card) + step)) return;
  // Keep keyboard focus on the moved card. At either end, use the button that still works.
  const item = cardElement(id);
  const same = item?.querySelector(step < 0 ? '.kanban-move-up' : '.kanban-move-down');
  (same?.disabled ? item.querySelector(step < 0 ? '.kanban-move-down' : '.kanban-move-up') : same)?.focus();
}

async function copyCard(card, button) {
  try {
    await navigator.clipboard.writeText(card.prompt);
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = 'Copy prompt'; }, 1800);
    announce(`Prompt copied: ${card.title}. Paste it into your coding agent.`);
  } catch {
    openCard(card.id);
    $('#card-prompt').select();
    $('#card-error').textContent = 'Clipboard access is unavailable. The prompt is selected. Press Command+C or Control+C to copy it.';
    $('#card-error').hidden = false;
  }
}

async function duplicateCard(id) {
  try {
    const { task } = await boardCall('POST', `/api/tasks/${encodeURIComponent(id)}/duplicate`, {});
    announce(`Duplicated “${findTask(id)?.title || task.title}” into To Do.`);
    cardElement(task.id)?.querySelector('.kanban-open').focus();
  } catch (error) { showBoardError(error); }
}

function confirmCardDelete(item, card, focus = true) {
  const keep = detailButton('Keep card', () => {
    if (item.closest('#done-dialog')) {
      const replacement = renderDoneCard(findTask(card.id) || card, Number(item.querySelector('.kanban-done-number').textContent.slice(1)), false);
      item.replaceWith(replacement);
      replacement.querySelector('.kanban-more-toggle')?.focus();
    } else {
      item.querySelector('.kanban-confirm')?.remove();
      renderBoard();
      cardElement(card.id)?.querySelector('.kanban-more-toggle')?.focus();
    }
  });
  const confirm = document.createElement('div');
  confirm.className = 'connection-detail kanban-confirm';
  const note = card.workspace ? ` Files and branch are kept at ${card.workspace.path}.` : '';
  confirm.append(paragraph(`Delete “${card.title}”? This cannot be undone.${note}`), detailActions(detailButton('Delete card', () => deleteCard(card.id), 'danger'), keep));
  item.querySelector('.kanban-more').remove();
  item.querySelector('.kanban-actions').remove();
  item.append(confirm);
  if (focus) keep.focus();
}

const deletingCards = new Set();
async function deleteCard(id) {
  const card = findTask(id);
  if (!card || deletingCards.has(id)) return;
  deletingCards.add(id);
  try { await boardCall('DELETE', `/api/tasks/${encodeURIComponent(id)}?expectedRevision=${card.revision}&keepFiles=true`); }
  catch (error) { renderBoard(); showBoardError(error); return; }
  finally { deletingCards.delete(id); }
  try { localStorage.removeItem(`promptboard.card-appearance.${id}`); } catch {}
  if ($('#done-dialog').open) $('#done-dialog').close();
  announce(`Deleted “${card.title}”.`);
  ($('#kanban-columns .kanban-open') || $('#card-new')).focus();
}

let quickTask = false;
function openCard(id = null, quick = false) {
  quickTask = quick;
  const project = currentProject();
  if (!project) return;
  const card = id ? project.tasks.find(item => item.id === id) : null;
  editingCardId = card?.id || null;
  $('#card-dialog-project').textContent = `${project.name} · ${columnTitle(card?.column || 'todo')}`;
  $('#card-dialog-heading').textContent = card ? 'Edit card' : 'New card';
  $('#card-refine').hidden = Boolean(card);
  $('#card-refine').disabled = running;
  $('#card-title').required = !quick;
  $('#card-title').placeholder = quick ? 'Optional — derived from your prompt' : '';
  $('#card-title').value = card?.title || '';
  $('#card-prompt').value = card?.prompt || '';
  const status = card && cardStatus(card);
  $('#card-status').hidden = !card;
  $('#card-status').textContent = status?.text || '';
  $('#card-status').classList.toggle('needs-review', Boolean(status?.flag));
  $('#card-note').textContent = !card?.source ? 'Write the task as your coding agent should receive it. Copy prompt copies this text exactly.'
    : card.checksOutdated ? 'This prompt was edited. The checks from generation apply to the original text only. Your prompt history is unchanged.'
    : 'Imported from Compose. Saving changes marks the previous checks as outdated. Your prompt history is unchanged.';
  $('#card-source').hidden = !card?.source;
  $('#card-source').open = false;
  $('#card-source-list').replaceChildren();
  if (card?.source) {
    const source = card.source;
    const rows = [
      `Provider: ${providerInfo[source.provider]?.name || 'not recorded'}`, `Model requested: ${source.model || 'CLI default'}`,
      `Models reported: ${source.reportedModels.length ? source.reportedModels.join(', ') : 'not reported by CLI'}`, `Effort requested: ${source.effort || 'CLI default'}`,
      `Language: ${LANGUAGE_NAMES[source.language] || 'not recorded'}`, `Check mode: ${source.quality === 'fast' ? 'Fast' : source.quality === 'reviewed' ? 'Reviewed' : 'not recorded'}`,
      `Status at generation: ${{ 'checks-passed': 'checks complete', 'needs-review': 'review needed', none: 'no verification report' }[source.verification]}`,
      `Generated: ${source.generatedAt ? new Date(source.generatedAt).toLocaleString() : 'not recorded'}`,
    ];
    for (const row of rows) { const item = document.createElement('li'); item.textContent = row; $('#card-source-list').append(item); }
  }
  $('#card-error').hidden = true;
  if (!$('#card-dialog').open) $('#card-dialog').showModal();
  $(quick ? '#card-prompt' : '#card-title').focus();
}

async function saveCard(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const card = editingCardId ? project.tasks.find(item => item.id === editingCardId) : null;
  const typed = $('#card-prompt').value;
  const title = $('#card-title').value.trim() || (quickTask ? typed.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
  const error = !title ? 'Enter a short title.' : title.length > 120 ? 'Use a title of at most 120 characters.'
    : !typed.trim() ? 'Enter the prompt for this task.' : typed.length > MAX_PROMPT_BYTES ? 'The prompt exceeds the 2 MiB limit.' : '';
  if (error) { $('#card-error').textContent = error; $('#card-error').hidden = false; return; }
  let saved, message;
  try {
    if (card) {
      // A textarea turns \r\n into \n. Keep the stored text when nothing else changed.
      const prompt = typed === card.prompt.replace(/\r\n?/g, '\n') ? card.prompt : typed;
      const result = await boardCall('PATCH', `/api/tasks/${encodeURIComponent(card.id)}`, { title, prompt, expectedRevision: card.revision });
      saved = result.task;
      message = !result.changed ? 'No changes to save.' : saved.checksOutdated && card.source ? `Saved “${title}”. The previous checks are now marked as outdated.` : `Saved “${title}”.`;
    } else {
      saved = (await boardCall('POST', '/api/tasks', { projectId: project.id, title, prompt: typed })).task;
      message = `Added “${title}” to To Do.`;
    }
  } catch (failure) { $('#card-error').textContent = failure.message; $('#card-error').hidden = false; return; }
  $('#card-dialog').close();
  announce(message);
  cardElement(saved.id)?.querySelector('.kanban-open').focus();
}

function projectNameError(name, exceptId = null) {
  if (!name) return 'Enter a project name.';
  if (name.length > 80) return 'Use a project name of at most 80 characters.';
  if (board?.projects.some(project => project.id !== exceptId && project.name.toLowerCase() === name.toLowerCase())) return 'A project with this name already exists.';
  return '';
}

function showProjectDetail(...nodes) {
  $('#project-detail').replaceChildren(...nodes);
  $('#project-detail').hidden = nodes.length === 0;
  if (nodes.length) setProjectCollapsed(false, false);
}

function openProjectForm(mode) {
  projectFormMode = mode;
  showProjectDetail();
  $('#project-form-label').textContent = mode === 'rename' ? 'Rename project' : 'New project name';
  $('#project-form-note').hidden = mode === 'rename';
  $('#project-name').value = mode === 'rename' ? currentProject()?.name || '' : '';
  $('#project-error').hidden = true;
  $('#project-form').hidden = false;
  setProjectCollapsed(false, false);
  $('#project-name').focus();
}

function closeProjectForm() { $('#project-form').hidden = true; $('#project-error').hidden = true; }

async function saveProject(event) {
  event.preventDefault();
  const name = $('#project-name').value.trim();
  const project = projectFormMode === 'rename' ? currentProject() : null;
  const showError = message => { $('#project-error').textContent = message; $('#project-error').hidden = false; $('#project-name').focus(); };
  const error = projectNameError(name, project?.id);
  if (error) { showError(error); return; }
  try {
    if (project) {
      await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}`, { name, expectedRevision: project.revision });
      announce(`Renamed “${project.name}” to “${name}”.`);
    } else {
      // The server creates the project's own folder with a Git repository and links it.
      const result = await boardCall('POST', '/api/projects', { name, folder: 'new' });
      savePref(SELECTED_PROJECT_KEY, result.project.id);
      renderBoard();
      announce(`Created project “${name}” with a Git repository in ${result.folder}.`);
    }
  } catch (failure) { showError(failure.message); return; }
  closeProjectForm();
  $('#project-select').focus();
}

function confirmProjectDelete() {
  const project = currentProject();
  if (!project) return;
  closeProjectForm();
  const keep = detailButton('Keep project', () => { showProjectDetail(); $('#project-delete').focus(); });
  showProjectDetail(
    paragraph(`Delete “${project.name}” and its ${plural(project.tasks.length, 'card')}? This cannot be undone. Export a backup first if you want to keep them.`),
    detailActions(detailButton('Delete project', () => deleteProject(project), 'danger'), keep),
  );
  keep.focus();
}

async function deleteProject(project) {
  try { await boardCall('DELETE', `/api/projects/${encodeURIComponent(project.id)}?expectedRevision=${project.revision}`); }
  catch (error) { showBoardError(error); return; }
  showProjectDetail();
  savePref(SELECTED_PROJECT_KEY, board.projects[0]?.id || '');
  renderBoard();
  announce(`Deleted project “${project.name}”.`);
  $(board.projects.length ? '#project-select' : '#project-new').focus();
}

// ---- Agent runs (PB-03): controls, consent, confirmation, details, workflow ----

const RUN_LIVE = ['queued', 'running', 'waiting_for_input'];
const STAGE_VERBS = { planning: 'Start planning', executing: 'Start executing', code_review: 'Start review', testing: 'Start testing agent', merge: 'Start merge agent' };
/** The Start button label; a custom column has one only when it runs an agent. */
function stageVerb(stage) { return STAGE_VERBS[stage] || (projectColumnsOf().find(column => column.id === stage)?.agent ? 'Start agent' : ''); }
// Stages whose agents are read-only (plan mode, read-only sandbox). The others write in the worktree.
const READ_ONLY_STAGES = ['planning', 'code_review'];
const capabilityFor = stage => READ_ONLY_STAGES.includes(stage) ? 'planning' : 'execution';
const POLICY_LABELS = { manual: 'Manual', start: 'Start automatically' };

function activeRun(taskId) { return board?.runs.find(run => run.taskId === taskId && RUN_LIVE.includes(run.status)) || null; }
function elapsed(run) {
  const end = RUN_LIVE.includes(run.status) ? Date.now() : run.endedAt || run.updatedAt;
  const seconds = Math.max(0, Math.round((end - (run.startedAt || run.createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function providerName(id) { return board?.execution?.providers?.[id]?.name || providerInfo[id]?.name || id; }

// One agent status model for the sidebar, cards, and dock. It comes from the run's real status
// (reported by the supervisor from provider events), never from the card's column.
const AGENT_STATES = { queued: 'on_hold', running: 'active', waiting_for_input: 'awaits_you' };
const AGENT_STATE_TEXT = { active: 'Active', on_hold: 'On hold', awaits_you: 'Awaits you', inactive: 'Inactive' };
const AGENT_STATE_ICON = { active: '●', on_hold: '○', awaits_you: '!', inactive: '–' };
function agentState(run) {
  if (run?.config?.pipeline && RUN_LIVE.includes(run.status) && run.status !== 'queued' && run.activity) {
    if (run.activity.phase === 'working') return 'active';
    if (run.activity.phase === 'waiting') return 'awaits_you';
  }
  return AGENT_STATES[run?.status] || 'inactive';
}
function agentStateText(run) {
  if (run?.status === 'suspended') return 'Paused';
  const state = agentState(run);
  return state === 'inactive' && run?.status ? `Inactive · ${run.status.replaceAll('_', ' ')}` : AGENT_STATE_TEXT[state];
}
function agentModel(run) { return `${providerName(run.config?.provider)} · ${run.config?.model || 'CLI default model'}${run.config?.effort ? ` · ${run.config.effort}` : ''}`; }
function agentActivity(run) {
  if (run?.lifecycle === 'suspending' && RUN_LIVE.includes(run.status)) return 'Pausing the agent; waiting for its process to exit…';
  const state = agentState(run);
  if (run?.config?.pipeline && RUN_LIVE.includes(run.status) && run.status !== 'queued' && run.activity) {
    const activity = run.activity;
    if (activity.phase === 'waiting') return !run.turnComplete && run.waitingReason || 'The agent needs your answer in the terminal.';
    const work = [];
    for (const [key, label] of [['tools', 'tool'], ['subagents', 'subagent'], ['background', 'background task'], ['scheduled', 'scheduled wakeup']]) {
      if (activity[key]) work.push(`${activity[key]} ${label}${activity[key] === 1 ? '' : 's'}`);
    }
    if (work.length) return `Working… ${work.join(', ')} outstanding.`;
    if (activity.uncertain) return 'Activity tracking is incomplete. Check the terminal before continuing.';
    if (activity.phase === 'settling') return 'The agent finished its response; waiting for terminal output to settle…';
    if (activity.phase === 'ended') return 'The CLI reported that its session ended.';
    if (activity.coverage === 'turns-only' && state === 'active') return 'Working… this CLI reports completed turns; tool activity and permission waits are visible in the terminal.';
  }
  if (state === 'awaits_you') return run.waitingReason || (run.turnComplete ? 'Turn finished. Review the changes or continue in the terminal.' : 'Permission or input needed. Open the terminal.');
  if (state === 'on_hold') return 'Queued until an agent slot is free.';
  if (state === 'active') return run.lifecycle === 'waiting-for-first-event' ? 'Starting…' : run.lifecycle === 'no-events-yet' ? 'Working… no lifecycle event yet; check the terminal.' : 'Working…';
  return run?.reason || '';
}
const tokens = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
/** Usage as the CLI reported it, or nothing. Context is the size of the latest request, not task progress. */
function usageText(run) {
  const usage = run?.usage;
  if (!usage || typeof usage !== 'object') return '';
  const parts = [`Input ${tokens(usage.inputTokens || 0)}`, `Cached ${tokens(usage.cachedTokens || 0)}`, `Output ${tokens(usage.outputTokens || 0)}`];
  if (usage.contextTokens) parts.push(usage.contextWindow ? `Context ${Math.round(usage.contextTokens / usage.contextWindow * 100)}% (${tokens(usage.contextTokens)} of ${tokens(usage.contextWindow)})` : `Context ${tokens(usage.contextTokens)} tokens`);
  if (usage.model && usage.model !== run.config?.model) parts.push(`Reported model ${usage.model}`);
  if (usage.rateLimit) parts.push(`Plan usage ${Math.round(usage.rateLimit.usedPercent)}%${usage.rateLimit.resetsAt ? `, resets ${new Date(usage.rateLimit.resetsAt).toLocaleString()}` : ''}`);
  return parts.join(' · ');
}
function elapsedSpan(run) {
  const span = document.createElement('span');
  span.dataset.elapsedRun = run.id;
  span.textContent = elapsed(run);
  return span;
}
// Live elapsed times tick without re-rendering the board.
function tickElapsed() {
  if (!board || document.hidden) return;
  for (const element of document.querySelectorAll('[data-elapsed-run]')) {
    const run = board.runs.find(item => item.id === element.dataset.elapsedRun);
    if (run && RUN_LIVE.includes(run.status)) element.textContent = elapsed(run);
  }
  window.PromptboardDock?.tick();
}
setInterval(tickElapsed, 1000);

const AGENTS_FILTER_KEY = 'promptboard.agents.filter';
const AGENT_RECENT_MS = 30 * 60 * 1000;
const AGENT_ORDER = { awaits_you: 0, active: 1, on_hold: 2, inactive: 3 };
/** Live runs, plus each task's latest run if it ended in the last 30 minutes. */
function agentRuns(filter, current) {
  const owners = new Map((board?.projects || []).flatMap(project => project.tasks.map(task => [task.id, { task, project }])));
  const latest = new Map();
  for (const run of board?.runs || []) latest.set(run.taskId, run);
  const now = Date.now();
  return (board?.runs || []).filter(run => {
    const owner = owners.get(run.taskId);
    if (!owner || (filter !== 'all' && owner.project.id !== current?.id)) return false;
    return RUN_LIVE.includes(run.status) || (latest.get(run.taskId) === run && now - (run.endedAt || run.updatedAt || 0) < AGENT_RECENT_MS);
  }).map(run => ({ run, ...owners.get(run.taskId) }))
    .sort((a, b) => AGENT_ORDER[agentState(a.run)] - AGENT_ORDER[agentState(b.run)] || (b.run.updatedAt || 0) - (a.run.updatedAt || 0)).slice(0, 50);
}

function renderAgents(current) {
  let filter = 'project';
  try { filter = localStorage.getItem(AGENTS_FILTER_KEY) === 'all' ? 'all' : 'project'; } catch {}
  $('#agents-filter').value = filter;
  const rows = agentRuns(filter, current);
  $('#agents-count').textContent = String(rows.filter(row => RUN_LIVE.includes(row.run.status)).length).padStart(2, '0');
  $('#agents-list').replaceChildren(...rows.map(({ run, task, project }) => {
    const state = agentState(run);
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `agent-item ${state}`;
    button.dataset.runId = run.id;
    const icon = document.createElement('span'); icon.className = `agent-icon ${state}`; icon.setAttribute('aria-hidden', 'true'); icon.textContent = AGENT_STATE_ICON[state];
    const name = document.createElement('span'); name.className = 'agent-title'; name.textContent = task.title;
    const model = document.createElement('span'); model.className = 'agent-meta agent-model'; model.textContent = agentModel(run);
    const status = document.createElement('span'); status.className = 'agent-meta';
    const stateText = document.createElement('span'); stateText.className = 'agent-state'; stateText.textContent = agentStateText(run);
    status.append(`${columnTitle(run.stage, project)} · `, stateText, ' · ', elapsedSpan(run));
    button.append(icon, name, model, status);
    const other = project.id !== current?.id;
    if (other) { const where = document.createElement('span'); where.className = 'agent-meta'; where.textContent = `Project: ${project.name}`; button.append(where); }
    button.setAttribute('aria-label', `${task.title}: ${agentStateText(run)}. ${columnTitle(run.stage)}. ${agentModel(run)}.${other ? ` Project ${project.name}.` : ''}`);
    button.title = [task.title, agentActivity(run), run.branch ? `Branch ${run.branch}` : ''].filter(Boolean).join('\n');
    button.addEventListener('click', () => selectAgent(run.id));
    item.append(button);
    return item;
  }));
}

/** Show an agent's project, card, and existing terminal. Never starts a run. */
function selectAgent(runId) {
  const run = board?.runs.find(item => item.id === runId);
  const owner = run && board.projects.find(project => project.tasks.some(task => task.id === run.taskId));
  if (!owner) return;
  if (owner.id !== currentProject()?.id) selectProject(owner.id);
  setSidebar(false);
  window.PromptboardDock?.open(run.id);
  const card = cardElement(run.taskId);
  if (card) {
    for (const other of document.querySelectorAll('.kanban-card.agent-focus')) other.classList.remove('agent-focus');
    card.classList.add('agent-focus');
    card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    card.querySelector('.kanban-open')?.focus({ preventScroll: true });
  }
}
$('#agents-filter').addEventListener('change', () => { savePref(AGENTS_FILTER_KEY, $('#agents-filter').value); renderAgents(currentProject()); });

function renderRunControls(card, run) {
  const box = document.createElement('div');
  box.className = 'kanban-run';
  const active = run && RUN_LIVE.includes(run.status) ? run : null;
  if (run) {
    const badge = document.createElement('span');
    const state = agentState(run);
    badge.className = `run-badge${state === 'awaits_you' ? ' waiting awaits' : state === 'active' ? ' running' : ['failed', 'interrupted'].includes(run.status) ? ' failed' : ''}`;
    badge.append(`${columnTitle(run.stage)} · ${state === 'awaits_you' ? 'AWAITS YOU' : agentStateText(run)} · `, elapsedSpan(run));
    badge.title = [agentModel(run), run.waitingReason || run.reason].filter(Boolean).join(' · ');
    box.append(badge, paragraph(`Run agent: ${agentModel(run)}`, 'run-agent'));
    const activity = active ? agentActivity(run) : '';
    if (activity) { const line = paragraph(activity, 'run-activity'); line.title = activity; box.append(line); }
  }
  const labelled = (button, label) => { button.setAttribute('aria-label', `${label}: ${card.title}`); return button; };
  // The Merge stage's own work (preparing, merge agent, readiness, or the blocker) is shown on the card.
  const flow = card.flow;
  const flowText = { 'merge-tests': 'Bringing in the target branch: tests are running again…', 'merge-resolve': 'The merge agent is resolving conflicts…', ready: `Ready to merge into ${flow?.targetBranch || 'the target branch'}.`, 'testing-agent': 'The testing agent starts if the tests fail.', blocked: flow?.reason }[flow?.kind];
  if (flowText) box.append(paragraph(flowText, `run-activity flow-${flow.kind}${flow.kind === 'blocked' ? ' kanban-error' : ''}`));
  if (active) {
    box.append(labelled(detailButton('Terminal', () => window.PromptboardDock?.open(active.id), 'kanban-terminal'), 'Show terminal'));
    const pause = labelled(detailButton('Pause', () => pauseAgent(active), 'kanban-pause'), 'Pause agent');
    pause.disabled = active.lifecycle === 'suspending'; box.append(pause);
    // Plan approval stays available; moving the card to Executing also approves the plan.
    if (!active.config?.pipeline && active.stage === 'planning' && active.status === 'waiting_for_input' && active.turns > 0) box.append(labelled(detailButton('Approve plan', () => openTaskDetails(card.id), 'kanban-confirm-run'), 'Review and approve the plan'));
  } else if (currentProject()?.workflowMode === 'pipeline') {
    if (projectColumnsOf().find(column => column.id === card.column)?.role === 'active') {
      const start = labelled(detailButton('Start agent', () => startStage(card, card.column), 'primary kanban-start'), 'Start agent');
      start.disabled = !board?.execution?.available || !currentProject()?.repository; box.append(start);
    }
  } else if (card.column === 'merge') {
    const target = currentProject()?.targetBranch?.name || 'target';
    box.append(labelled(detailButton(`Merge ${target}`, () => mergeCard(card), 'primary kanban-merge'), `Merge into ${target}`));
    box.append(labelled(detailButton(card.evidence?.pullRequest?.state === 'OPEN' ? 'Update pull request' : 'Open pull request', () => pullRequestCard(card), 'kanban-pr'), 'Open a pull request'));
  } else if (stageVerb(card.column)) {
    if (card.column === 'testing') box.append(labelled(detailButton(card.evidence?.tests ? 'Run tests again' : 'Run tests', () => runTestsCard(card), 'primary kanban-deliver'), 'Run tests'));
    const start = labelled(detailButton(stageVerb(card.column), () => startStage(card, card.column), `${card.column === 'testing' ? '' : 'primary '}kanban-start`), stageVerb(card.column));
    start.disabled = !board?.execution?.available || !currentProject()?.repository;
    if (start.disabled) start.title = !board?.execution?.available ? 'Agent terminals are not set up.' : 'Link a repository first.';
    box.append(start);
    const selected = currentProject()?.effectiveWorkflow?.[card.column];
    box.append(paragraph(`Next run: ${agentText(selected)}`, 'run-agent'));
  }
  if (run && !active) box.append(labelled(detailButton('View output', () => window.PromptboardDock?.open(run.id), 'kanban-terminal'), 'View saved agent output'));
  const conversation = board?.sessions?.find(session => session.id === card.sessionId);
  if (!active && (currentProject()?.workflowMode === 'pipeline' ? projectColumnsOf().find(column => column.id === card.column)?.role === 'active' : run?.stage === card.column && !['todo', 'done'].includes(card.column)) && conversation?.nativeSessionId && ['suspended', 'orphaned', 'exited'].includes(conversation.status) && !card.archivedAt) {
    const resume = labelled(detailButton('Resume', () => resumeAgent(card), 'kanban-resume'), 'Resume conversation');
    resume.disabled = !board?.execution?.available || !currentProject()?.repository;
    box.append(resume);
  }
  box.append(labelled(detailButton('Details', () => openTaskDetails(card.id), 'kanban-details'), 'Task details'));
  return box;
}

// Model choices for agent runs come from the installed CLI (the same list Compose shows, cached by
// the server). "Custom model ID…" keeps any other ID possible; the CLI still validates it.
const runCatalogs = new Map();
function modelCatalog(provider, refresh = false) {
  if (refresh || !runCatalogs.has(provider)) {
    const request = api(`/api/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=1' : ''}`, { timeoutMs: 20000 })
      .then(({ response, data }) => response.ok ? data : null).catch(() => null)
      .then(data => { if (!data?.models?.length && runCatalogs.get(provider) === request) runCatalogs.delete(provider); return data || { models: [] }; });
    runCatalogs.set(provider, request);
  }
  return runCatalogs.get(provider);
}
function fillModelSelect(select, custom, catalog, value = '', loading = false) {
  const models = catalog?.models || [];
  const known = !value || models.some(item => item.id === value);
  select.replaceChildren(option('', loading ? 'Reading models from your CLI…' : catalog?.defaultModel ? `CLI default (${catalog.defaultModel})` : 'CLI default'),
    ...models.map(item => option(item.id, item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id)),
    option('__custom__', 'Custom model ID…'));
  // While the list loads, a saved model stays selected as a custom ID so it is never lost.
  select.value = known ? value : '__custom__';
  if (!known) custom.value = value;
  custom.hidden = select.value !== '__custom__';
}
async function loadModelSelect(select, custom, provider, value, refresh = false) {
  const request = String(Number(select.dataset.catalogRequest || 0) + 1);
  select.dataset.catalogRequest = request;
  fillModelSelect(select, custom, null, value, true);
  const catalog = await modelCatalog(provider, refresh);
  if (select.dataset.provider !== provider || select.dataset.catalogRequest !== request) return null;
  fillModelSelect(select, custom, catalog, select.value === '__custom__' ? custom.value.trim() : select.value);
  return catalog;
}
function chosenModelFrom(select, custom) { return select.value === '__custom__' ? custom.value.trim() : select.value; }

function fillSelect(select, values, labels = {}) { select.replaceChildren(...values.map(value => option(value, labels[value] ?? (value || 'CLI default')))); }

const EFFORTS = { codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'], gemini: [] };
function effortsFor(provider) { return EFFORTS[provider] || []; }

/**
 * Provider, model, and effort fields for one level of the agent hierarchy. `inherit` adds an
 * empty provider choice that means "use the next level" (its label says which agent that is).
 */
function agentFields(value = {}, { inherit = '', stage = 'executing', inheritedProvider = board?.settings?.defaultAgent?.provider || 'claude' } = {}) {
  const grid = document.createElement('div'); grid.className = 'select-grid';
  grid.dataset.inheritedProvider = inheritedProvider;
  const providers = board?.execution?.providers || {};
  const supported = Object.keys(providers).filter(id => providers[id][capabilityFor(stage)]?.supported);
  const label = (text, control) => { const field = document.createElement('label'); field.className = 'field-label'; field.textContent = text; field.append(control); return field; };
  const provider = document.createElement('select'); provider.dataset.field = 'provider';
  fillSelect(provider, [...(inherit ? [''] : []), ...(supported.length ? supported : ['claude'])], { '': inherit, ...Object.fromEntries(Object.entries(providers).map(([id, item]) => [id, item.name])) });
  provider.value = value.provider || '';
  if (!inherit && !provider.value) provider.value = supported[0] || 'claude';
  const model = document.createElement('select'); model.dataset.field = 'model';
  const custom = document.createElement('input'); Object.assign(custom, { type: 'text', maxLength: 100, placeholder: 'Custom model ID', spellcheck: false }); custom.dataset.field = 'model-custom'; custom.setAttribute('aria-label', 'Custom model ID');
  const effort = document.createElement('select'); effort.dataset.field = 'effort';
  const permission = document.createElement('select'); permission.dataset.field = 'permissionMode';
  const readOnly = ['planning', 'code_review'].includes(stage);
  const permissionBox = label('Permissions', permission);
  const permissionNote = paragraph('', 'agent-model-note');
  const refreshPermissions = (keep = permission.value) => {
    const effective = provider.value || grid.dataset.inheritedProvider;
    const modes = readOnly ? ['plan'] : ['', 'auto', ...(effective === 'codex' ? [] : ['approve_edit'])];
    fillSelect(permission, modes, { '': 'Inherit / provider default', plan: 'Plan Mode (read-only)', auto: effective === 'codex' ? 'Auto · sandbox, approval on request' : 'Auto · approve file edits', approve_edit: 'Approve edit · ask before changes' });
    const canonical = ['acceptEdits', 'auto_edit', 'workspace-write'].includes(keep) ? 'auto' : keep === 'default' ? 'approve_edit' : keep;
    permission.value = readOnly ? 'plan' : modes.includes(canonical) ? canonical : '';
    permission.disabled = readOnly;
    permissionBox.hidden = !provider.value && !readOnly && !grid.closest('[data-stage]');
    permissionNote.hidden = !readOnly && effective !== 'codex';
    permissionNote.textContent = readOnly ? 'Plan Mode is enforced for every model. This stage cannot edit files.' : 'Codex automatically edits inside its workspace sandbox and asks for escalation. It has no per-file Approve edit mode.';
  };
  grid.addEventListener('agent-inheritance-change', () => refreshPermissions());
  const modelBox = document.createElement('div'); modelBox.className = 'model-field'; modelBox.append(label('Model', model), custom);
  const note = paragraph('', 'agent-model-note');
  let nativeCatalog = null;
  const refreshEffort = (keep = effort.value) => {
    const chosenModel = chosenModelFrom(model, custom);
    const metadata = nativeCatalog?.models?.find(item => item.id === (chosenModel || nativeCatalog.defaultModel));
    const efforts = metadata ? metadata.efforts || [] : effortsFor(provider.value);
    fillSelect(effort, ['', ...efforts], { '': 'CLI default' });
    effort.value = efforts.includes(keep) ? keep : '';
    effort.disabled = !efforts.length;
  };
  const refresh = (keep = {}) => {
    const chosen = provider.value;
    model.dataset.provider = chosen;
    nativeCatalog = null;
    modelBox.hidden = !chosen; effort.parentElement && (effort.parentElement.hidden = !chosen);
    note.hidden = !chosen;
    refreshModels.hidden = !chosen;
    refreshPermissions(keep.permissionMode || '');
    if (!chosen) return;
    note.textContent = 'Reading models from your CLI…';
    loadModelSelect(model, custom, chosen, keep.model || '', keep.refresh === true).then(catalog => {
      if (!catalog) return;
      nativeCatalog = catalog;
      refreshEffort();
      note.textContent = catalog.models?.length ? 'Models reported by this CLI. You can also enter a custom model ID.' : catalog.note || 'Model list unavailable. Use CLI default or enter a custom model ID.';
    });
    refreshEffort(keep.effort || '');
  };
  const refreshModels = detailButton('Refresh models', () => refresh({ model: chosenModelFrom(model, custom), effort: effort.value, permissionMode: permission.value, refresh: true }), 'text-button agent-refresh-models');
  provider.addEventListener('change', () => { custom.value = ''; refresh(); });
  model.addEventListener('change', () => { custom.hidden = model.value !== '__custom__'; refreshEffort(); if (!custom.hidden) custom.focus(); });
  custom.addEventListener('input', () => refreshEffort());
  grid.append(label('Provider', provider), modelBox, label('Effort', effort), permissionBox, permissionNote, note, refreshModels);
  refresh(value);
  return grid;
}
function readAgentFields(root) {
  const value = field => root.querySelector(`[data-field="${field}"]`)?.value || '';
  if (!value('provider')) return null;
  const permissionMode = value('permissionMode');
  return { provider: value('provider'), model: (value('model') === '__custom__' ? value('model-custom') : value('model')).trim(), effort: value('effort'), ...(permissionMode && permissionMode !== 'plan' ? { permissionMode } : {}) };
}
const agentText = agent => agent?.provider ? `${providerName(agent.provider)} · ${agent.model || 'CLI default model'}${agent.effort ? ` · ${agent.effort}` : ''}` : '';

function locationFact(label, value) {
  const row = document.createElement('div'); row.className = 'location-fact';
  const name = document.createElement('strong'); name.textContent = label;
  const text = document.createElement('code'); text.textContent = value || 'Not set';
  row.append(name, text);
  if (value) row.append(detailButton(`Copy ${label.toLowerCase()}`, async () => {
    try { await navigator.clipboard.writeText(value); announce(`${label} copied.`); }
    catch { announce(`Clipboard unavailable. Select and copy the ${label.toLowerCase()} shown here.`); }
  }, 'text-button location-copy'));
  return row;
}

function taskLocation(card, project) {
  const facts = document.createElement('div'); facts.className = 'task-location';
  const ws = card.workspace;
  const completedBranch = card.completion?.kind === 'merged' ? card.completion.targetBranch : '';
  facts.append(locationFact('Repository', ws?.repositoryRoot || project?.repository?.root), locationFact('Target branch', completedBranch || ws?.targetBranch || project?.targetBranch?.name));
  if (ws) facts.append(locationFact('Task branch', ws.branch), locationFact('Worktree', ws.path), locationFact('Base commit', ws.baseCommit), paragraph(completedBranch ? `Changes were merged into ${completedBranch}. The task worktree is still available here.` : 'The agent edits files in this worktree. They reach the target branch after a merge.', 'note'));
  else facts.append(paragraph(completedBranch ? `Changes were merged into ${completedBranch}. The task worktree has been removed; the task branch is kept in history.` : 'No worktree yet. The first Planning or Executing run creates a task branch and a separate folder.', 'note'));
  if (!ws && card.retainedBranches?.length) facts.append(locationFact('Retained task branch', card.retainedBranches.at(-1).branch));
  return facts;
}

let projectAgentFormKey = '';
function renderProjectContext(project) {
  $('#project-context').hidden = !project;
  if (!project) { projectAgentFormKey = ''; return; }
  $('#project-context-heading').textContent = project.name;
  $('#project-target').textContent = project.targetBranch?.name ? `→ ${project.targetBranch.name}` : 'Repository not linked';
  $('#project-location').replaceChildren(locationFact('Repository', project.repository?.root), locationFact('Target branch', project.targetBranch?.name));
  const inherited = board?.settings?.defaultAgent || { provider: 'claude' };
  const defaultAgent = project.agentDefaults?.provider ? project.agentDefaults : inherited;
  $('#project-agent-toggle').textContent = `${agentText(defaultAgent)} ▾`;
  $('#project-agent-toggle').title = `${agentText(defaultAgent)}. Choose the project provider, model, and effort.`;
  const overrides = Object.entries(project.effectiveWorkflow || {}).filter(([, value]) => value.agentSource === 'stage').map(([stage]) => columnTitle(stage));
  $('#project-agent-summary').textContent = `Project agent: ${agentText(defaultAgent)}. ${overrides.length ? `Stage overrides: ${overrides.join(', ')}.` : 'Every stage inherits this agent.'} Compose uses its own settings. Changes apply to new runs.`;
  const key = JSON.stringify([project.id, project.agentDefaults, board?.settings?.defaultAgent]);
  if (key !== projectAgentFormKey) {
    projectAgentFormKey = key;
    $('#project-agent-fields').replaceChildren(agentFields(project.agentDefaults || {}, { inherit: `Use global default (${agentText(inherited)})` }), basePicker({ target: { scope: 'project', projectId: project.id }, provider: defaultAgent.provider }));
    $('#project-agent-error').hidden = true;
  }
}

$('#project-agent-form').addEventListener('submit', async event => {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const agentDefaults = readAgentFields($('#project-agent-fields')) || {};
  const button = $('#project-agent-save'); button.disabled = true;
  try {
    await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/workflow`, { workflow: project.workflow || {}, agentDefaults, expectedRevision: project.revision });
    $('#project-agent-error').hidden = true;
    $('#project-agent-panel').hidden = true;
    $('#project-agent-toggle').setAttribute('aria-expanded', 'false');
    fitBoardHeight();
    announce(`Project agent saved for “${project.name}”. Existing runs keep their agent; new runs use the saved settings.`);
  } catch (error) { $('#project-agent-error').textContent = error.message; $('#project-agent-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#project-stages-open').addEventListener('click', () => openWorkflowDialog());
for (const [button, panel] of [['project-agent-toggle', 'project-agent-panel'], ['project-files-toggle', 'project-location']]) {
  $(`#${button}`).addEventListener('click', () => {
    const target = $(`#${panel}`); target.hidden = !target.hidden;
    $(`#${button}`).setAttribute('aria-expanded', String(!target.hidden));
    fitBoardHeight();
  });
}


/** Start the card's stage agent now (the card is already in that stage). No dialog: the click is the instruction. */
async function startStage(card, stage) {
  try {
    const { run } = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/runs`, { stage, consent: true }, 180000);
    announce(`${stageVerb(stage)} for “${card.title}”.`);
    showStartedRun(run.id);
  } catch (error) { showBoardError(error); }
}

const sessionActions = new Set();
async function pauseAgent(run) {
  if (sessionActions.has(run.taskId)) return;
  sessionActions.add(run.taskId);
  try { await boardCall('POST', `/api/runs/${encodeURIComponent(run.id)}/pause`, { confirm: true }, 20000); announce('Agent paused. Conversation, files and output are kept.'); }
  catch (error) { showBoardError(error); }
  finally { sessionActions.delete(run.taskId); }
}
async function resumeAgent(card) {
  if (sessionActions.has(card.id)) return;
  sessionActions.add(card.id);
  try {
    const { run } = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/resume`, { consent: true }, 180000);
    announce(`Resuming the conversation for “${card.title}”.`); showStartedRun(run.id);
  } catch (error) { showBoardError(error); }
  finally { sessionActions.delete(card.id); }
}
async function runTestsCard(card) {
  try { await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/tests`, { confirm: true }); announce(`Tests started for “${card.title}”.`); pollTests(card.id); }
  catch (error) { showBoardError(error); }
}
/** One click merges a verified card (the server brings in a moved target first). */
async function mergeCard(card) {
  try {
    const result = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/merge-now`, {}, 300000);
    announce(result.merged ? `Merged “${card.title}” into ${result.task?.completion?.targetBranch || 'the target branch'}. The card is Done.` : `“${card.title}”: ${result.merge?.message || 'the merge is being prepared.'}`);
  } catch (error) { showBoardError(error); }
}
/** One click pushes the task branch (never forced) and opens or updates its pull request. */
async function pullRequestCard(card) {
  const review = card.evidence?.review, tests = card.evidence?.tests;
  const body = [card.prompt.slice(0, 4000), '', '---', `Code review: ${review ? `${review.status}${review.verdict ? ` (${review.verdict.replaceAll('_', ' ')})` : ''} for ${short(review.taskCommit)}` : 'none'}`,
    `Tests: ${tests ? `${tests.status} (${(tests.results || []).length} commands) for ${short(tests.taskCommit)}` : 'none'}`, '', 'Opened by Promptboard.'].join('\n');
  try {
    const { task } = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/pull-request`, { confirm: true, title: card.title, body }, 300000);
    announce(`Pull request ${task.evidence?.pullRequest?.number ? `#${task.evidence.pullRequest.number} ` : ''}is open for “${card.title}”. The card moves to Done when it is merged.`);
  } catch (error) { showBoardError(error); }
}

async function confirmRun(run) {
  try { await boardCall('POST', `/api/runs/${encodeURIComponent(run.id)}/confirm`, {}); }
  catch (error) { showBoardError(error); return; }
  $('#task-dialog').close();
  announce(run.stage === 'planning' ? 'Plan approved. The agent session ended; the plan is saved with the task.' : 'Stage confirmed. The agent session ended; the worktree keeps the changes.');
}

async function openTaskDetails(taskId) {
  const card = findTask(taskId);
  if (!card) return;
  $('#task-dialog').dataset.taskId = taskId;
  const project = currentProject();
  const runs = board.runs.filter(run => run.taskId === taskId);
  const status = cardStatus(card);
  const section = (title, ...nodes) => { const box = document.createElement('section'); const heading = document.createElement('h3'); heading.textContent = title; box.append(heading, ...nodes); return box; };
  const pre = text => { const block = document.createElement('pre'); block.textContent = text; return block; };
  $('#task-dialog-stage').textContent = `${project.name} · ${columnTitle(card.column)}`.toUpperCase();
  $('#task-dialog-heading').textContent = card.title;
  const nodes = [
    section('Status', paragraph(`${status.text}. Task text revision ${card.contentRevision ?? 1}.${status.flag ? ' Review the prompt before you run an agent on it.' : ''}`)),
    section('Original prompt', pre(card.prompt)),
    section('Branch and worktree', taskLocation(card, project)),
    section('Base resources for future runs', basePicker({ target: { scope: 'task', projectId: project.id, taskId: card.id } }), paragraph('Task selections can narrow or opt out of inherited resources without changing the task text or approved evidence.')),
  ];
  const columnScope = document.createElement('select'); columnScope.setAttribute('aria-label', 'Column for task-specific Base resources');
  columnScope.append(...projectColumnsOf(project).map(column => option(column.id, column.title)));
  columnScope.value = card.column;
  const override = detailButton('Configure this task in this column…', () => baseView?.openPicker({ scope: 'task-column', projectId: project.id, taskId: card.id, columnId: columnScope.value }));
  nodes.at(-1).append(detailActions(columnScope, override));
  const planRun = [...runs].reverse().find(run => run.stage === 'planning' && run.hasPlan);
  if (planRun) {
    const approved = card.planApproval?.runId === planRun.id && card.planApproval.contentRevision === (card.contentRevision ?? 1);
    const planText = pre('Loading the plan…');
    nodes.push(section(`Plan${approved ? ' (approved)' : card.planApproval?.runId === planRun.id ? ' (approval is stale: the task changed)' : ''}`, planText));
    api(`/api/runs/${encodeURIComponent(planRun.id)}/plan`, { timeoutMs: 15000 }).then(({ data }) => { planText.textContent = data.text || planRun.planExcerpt || 'The plan text is not available.'; }).catch(() => { planText.textContent = planRun.planExcerpt || 'The plan text is not available.'; });
  }
  const waiting = runs.find(run => !run.config?.pipeline && run.status === 'waiting_for_input' && run.turns > 0);
  if (waiting) {
    const planning = waiting.stage === 'planning', reviewing = waiting.stage === 'code_review';
    nodes.push(section(planning ? 'Approve the plan' : reviewing ? 'Record the review' : 'Confirm the stage',
      paragraph(planning ? 'Approving saves this plan for this exact task text and ends the planning session. Implementation starts only when you start Executing.'
        : reviewing ? 'Recording saves the findings for the reviewed commit and ends the review session. Accepting the review is a separate decision.'
        : 'Confirming records this stage as done and ends the agent session. The changes stay in the task worktree. Promptboard does not judge the work for you.'),
      detailActions(detailButton(planning ? 'Approve plan' : reviewing ? 'Record review' : 'Confirm stage', () => confirmRun(waiting), 'danger'), detailButton('Open terminal', () => { $('#task-dialog').close(); window.PromptboardDock?.open(waiting.id); }))));
  }
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Stage', 'Provider and model', 'Status', 'Time', 'Notes']) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
  table.append(head);
  for (const run of [...runs].reverse()) {
    const row = document.createElement('tr');
    for (const value of [columnTitle(run.stage), `${providerName(run.config?.provider)} · ${run.config?.model || 'CLI default'}${run.config?.effort ? ` · ${run.config.effort}` : ''}`, run.status.replaceAll('_', ' ') + (run.trigger === 'automation' ? ' (started by workflow)' : ''), elapsed(run), run.waitingReason || run.reason || '']) {
      const td = document.createElement('td'); td.textContent = value; row.append(td);
    }
    if (['failed', 'interrupted'].includes(run.status)) row.className = 'run-failed';
    table.append(row);
  }
  nodes.push(section('Run history', runs.length ? table : paragraph('No runs yet.')));
  if (runs.length && baseView) nodes.push(baseView.runManifest(runs.at(-1)));
  const delivery = document.createElement('div');
  delivery.className = 'task-delivery';
  nodes.splice(3, 0, delivery);
  $('#task-details').replaceChildren(...nodes);
  if (project.workflowMode === 'pipeline') delivery.append(section('Conversation', renderRunControls(card, latestRun(card.id))));
  else renderDelivery(card, delivery, section, pre);
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
}

function workflowSummary(project) {
  const flow = project.effectiveWorkflow || {};
  return [...['planning', 'executing'].map(stage => `${columnTitle(stage)}: ${POLICY_LABELS[flow[stage]?.policy === 'manual' ? 'manual' : 'start']}`),
    ...(flow.merge?.policy === 'start' ? ['Merge: automatic'] : [])].join(' · ');
}

function workflowPreview(stage, settings) {
  const manual = settings.policy === 'manual';
  if (stage === 'merge') return manual ? 'Entering Merge checks the review and tests for the current commit and brings in a moved target branch. Then the card shows one button: Merge. One click merges; nothing is pushed.'
    : 'Entering Merge merges at once when the review and tests passed for the current commit and the merge is a fast-forward. A moved target branch is brought in first; conflicts go to the merge agent.';
  const provider = settings.provider ? providerName(settings.provider) : 'The inherited agent';
  const what = stage === 'planning' ? `${provider} writes a read-only plan` : stage === 'code_review' ? `${provider} reviews the committed diff read-only`
    : stage === 'testing' ? `${provider} tests the task results; after confirmation, configured commands independently verify exit codes` : `${provider} works in the task worktree`;
  return manual ? `Moving a card here only moves it. Start ${columnTitle(stage)} from the card.` : `Moving a card here starts it: ${what}.`;
}

function openWorkflowDialog(focusStage = null) {
  if (currentProject()?.workflowMode === 'pipeline') { openColumns(); if (focusStage) { columnsDraft.selected = focusStage; renderColumns(); } return; }
  const project = currentProject();
  if (!project) return;
  $('#workflow-dialog-project').textContent = `${project.name} · WORKFLOW`;
  const stages = [];
  const customAgents = (project.columnLayout || []).filter(entry => entry.custom && entry.agent?.enabled);
  for (const stage of ['planning', 'executing', 'code_review', 'testing', 'merge', ...customAgents.map(entry => entry.id)]) {
    const settings = project.effectiveWorkflow?.[stage] || {};
    const box = document.createElement('fieldset');
    box.className = 'workflow-stage';
    box.dataset.stage = stage;
    const legend = document.createElement('legend'); legend.textContent = columnTitle(stage);
    const policy = document.createElement('div'); policy.className = 'segmented';
    for (const value of ['start', 'manual']) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'radio'; input.name = `policy-${stage}`; input.value = value; input.checked = (settings.policy === 'manual' ? 'manual' : 'start') === value;
      const span = document.createElement('span'); span.textContent = stage === 'merge' ? (value === 'start' ? 'Merge automatically' : 'Merge button') : POLICY_LABELS[value];
      label.append(input, span); policy.append(label);
    }
    const preview = paragraph(workflowPreview(stage, settings), 'workflow-preview');
    const children = [legend, policy];
    if (STAGE_VERBS[stage] || customAgents.some(entry => entry.id === stage)) {
      const own = customAgents.find(entry => entry.id === stage)?.agent || project.workflow?.[stage] || {};
      const inherited = project.agentDefaults?.provider ? `Project default (${agentText(project.agentDefaults)})` : board?.settings?.defaultAgent?.provider ? `Global default (${agentText(board.settings.defaultAgent)})` : 'Default (Claude Code, CLI defaults)';
      const fields = agentFields(own, { inherit: inherited, stage, inheritedProvider: project.agentDefaults?.provider || board?.settings?.defaultAgent?.provider || 'claude' });
      const permissions = fields.querySelector('[data-field="permissionMode"]');
      if (permissions) permissions.parentElement.hidden = false;
      children.push(fields);
    }
    const instructionsField = document.createElement('label'); instructionsField.className = 'field-label'; instructionsField.textContent = 'Stage instructions (optional, added before the task text)';
    const instructions = document.createElement('textarea'); instructions.maxLength = 4000; instructions.value = settings.instructions || ''; instructions.dataset.field = 'instructions';
    instructionsField.append(instructions);
    if (stage === 'testing') {
      const commandsField = document.createElement('label'); commandsField.className = 'field-label'; commandsField.textContent = 'Test commands (one per line; run without a shell, in the task worktree)';
      const commands = document.createElement('textarea'); commands.id = 'test-commands'; commands.value = (project.testCommands || []).map(item => item.argv.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ')).join('\n');
      commands.placeholder = 'npm test';
      commandsField.append(commands);
      children.push(commandsField);
    }
    children.push(instructionsField);
    children.push(basePicker({ target: { scope: 'column', projectId: project.id, columnId: stage }, provider: settings.provider }));
    children.push(preview);
    box.append(...children);
    box.addEventListener('change', () => { preview.textContent = workflowPreview(stage, readWorkflowStage(box)); });
    stages.push(box);
  }
  const fixed = paragraph('Dragging a card is the instruction: its stage starts at once. To Do and Done never run agents. Planning is optional. After Testing, move to Done to save without merging, or to Merge for a separately approved merge. Reopen starts a new cycle. Each column runs only its own stage.', 'workflow-preview');
  // Agent hierarchy: a stage setting, else this project default, else the global default in Settings.
  const defaults = document.createElement('fieldset');
  defaults.className = 'workflow-stage workflow-defaults';
  const legend = document.createElement('legend'); legend.textContent = 'Project default agent';
  const global = board?.settings?.defaultAgent?.provider ? `Global default (${agentText(board.settings.defaultAgent)})` : 'Global default (Claude Code, CLI defaults)';
  defaults.append(legend, agentFields(project.agentDefaults || {}, { inherit: global }), basePicker({ target: { scope: 'project', projectId: project.id } }), paragraph('Every stage below uses this agent unless it names its own. Each card run uses it without asking again.', 'workflow-preview'));
  const refreshInheritance = () => {
    const inherited = readAgentFields(defaults) || board?.settings?.defaultAgent || { provider: 'claude' };
    for (const box of stages) {
      const provider = box.querySelector('[data-field="provider"]');
      if (provider?.options[0]?.value === '') provider.options[0].textContent = `Use project agent (${agentText(inherited)})`;
      const fields = box.querySelector('.select-grid');
      if (fields) { fields.dataset.inheritedProvider = inherited.provider; fields.dispatchEvent(new Event('agent-inheritance-change')); }
      box.querySelector('.workflow-preview').textContent = workflowPreview(box.dataset.stage, { ...inherited, ...readWorkflowStage(box) });
    }
  };
  const useForAll = detailButton('Use project agent for all columns', () => {
    for (const box of stages) {
      const provider = box.querySelector('[data-field="provider"]');
      const permission = box.querySelector('[data-field="permissionMode"]');
      const savedPermission = permission?.value;
      provider.value = '';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      if (permission && [...permission.options].some(option => option.value === savedPermission)) permission.value = savedPermission;
    }
    refreshInheritance();
  }, 'secondary-button');
  useForAll.id = 'workflow-use-project-agent';
  defaults.append(useForAll, paragraph('Or select a provider and model in any column below. Select the same provider with a different model to vary models. Save settings applies changes only to this project.', 'workflow-preview'));
  defaults.addEventListener('change', refreshInheritance);
  for (const box of stages) box.addEventListener('change', refreshInheritance);
  refreshInheritance();
  $('#workflow-stages').replaceChildren(defaults, ...stages, fixed);
  $('#workflow-error').hidden = true;
  $('#workflow-dialog').showModal();
  if (typeof focusStage === 'string') {
    const box = stages.find(box => box.dataset.stage === focusStage);
    box?.scrollIntoView?.({ block: 'start' });
    box?.querySelector('[data-field="provider"]')?.focus({ preventScroll: true });
  }
}

function readWorkflowStage(box) {
  const result = { policy: box.querySelector('input[type="radio"]:checked')?.value || 'start', instructions: box.querySelector('[data-field="instructions"]')?.value || '' };
  const permissionMode = box.querySelector('[data-field="permissionMode"]')?.value;
  if (permissionMode && permissionMode !== 'plan') result.permissionMode = permissionMode;
  const agent = readAgentFields(box);
  return agent ? { ...result, ...agent } : result;
}

async function saveWorkflow(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const workflow = Object.fromEntries([...$('#workflow-stages').querySelectorAll('.workflow-stage[data-stage]')].map(box => [box.dataset.stage, readWorkflowStage(box)]));
  const lines = ($('#test-commands')?.value || '').split('\n').map(line => line.trim()).filter(Boolean);
  try {
    await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/workflow`, { workflow, agentDefaults: readAgentFields($('#workflow-stages .workflow-defaults')) || {}, expectedRevision: project.revision });
    const changed = JSON.stringify(lines) !== JSON.stringify((project.testCommands || []).map(item => item.argv.map(arg => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ')));
    if (changed) await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/tests`, { commands: lines.map(command => ({ command })), expectedRevision: currentProject().revision });
  } catch (error) { $('#workflow-error').textContent = error.message; $('#workflow-error').hidden = false; return; }
  $('#workflow-dialog').close();
  announce(`Workflow settings saved for “${project.name}”. They apply to future runs.`);
}

// ---- Review, testing, merge, and completion (PB-04) in task details ----

const short = sha => String(sha || '').slice(0, 12);

async function deliveryAction(card, method, action, body, message) {
  try { await boardCall(method, `/api/tasks/${encodeURIComponent(card.id)}/${action}`, body, 120000); }
  catch (error) { showBoardError(error); if ($('#task-dialog').open) openTaskDetails(card.id); return false; }
  if (message) announce(message);
  if ($('#task-dialog').open && findTask(card.id)) openTaskDetails(card.id);
  return true;
}

function startOverSection(card, section, rev) {
  const target = currentProject()?.targetBranch?.name || 'the target branch';
  const pr = card.evidence?.pullRequest;
  const box = section('Start over', paragraph(`Not happy with this attempt? Start the same task again from a fresh branch of ${target}. Nothing is deleted.`));
  const open = () => {
    const reason = document.createElement('textarea'); reason.id = 'start-over-reason'; reason.maxLength = 4000; reason.rows = 3; reason.placeholder = 'Why? (optional: the next run gets this)';
    const now = document.createElement('label'); now.className = 'check-row';
    const startNow = document.createElement('input'); startNow.type = 'checkbox'; startNow.id = 'start-over-now';
    now.append(startNow, ' Start Executing right away');
    const facts = document.createElement('ul'); facts.className = 'dialog-list';
    for (const line of [
      `The branch ${card.workspace.branch} stays exactly as it is (${plural(rev.ahead, 'commit')}). It is not deleted, reset, or pushed.`,
      ...(rev.clean ? [] : [`${plural(rev.changes.length, 'uncommitted change')} will be committed to that branch first, so nothing is lost.`]),
      'The task worktree folder is removed. Review and test results move to the card’s history.',
      `The card goes to To Do. Its next run starts a new branch from the current ${target}.`,
      ...(pr?.url && pr.state === 'OPEN' ? [`Pull request #${pr.number ?? ''} stays open on GitHub. Close it there if you no longer want it.`] : []),
    ]) { const li = document.createElement('li'); li.textContent = line; facts.append(li); }
    const go = detailButton('Start over', async () => {
      go.disabled = true;
      try {
        const result = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/start-over`, { expectedRevision: card.revision, reason: reason.value.trim(), startExecuting: startNow.checked }, 180000);
        $('#task-dialog').close();
        announce(result.run ? `Started “${card.title}” over. Executing started on a fresh branch; the old attempt is kept on ${result.attempt.branch}.` : `Started “${card.title}” over. It is in To Do; the old attempt is kept on ${result.attempt.branch}.`);
        if (result.run) showStartedRun(result.run.id);
      } catch (error) { go.disabled = false; showBoardError(error); }
    }, 'danger start-over-confirm');
    box.replaceChildren(box.firstChild, box.children[1], facts, reason, now, detailActions(go, detailButton('Cancel', () => openTaskDetails(card.id))));
    reason.focus();
  };
  box.append(detailActions(detailButton('Start over…', open, 'start-over-open')));
  return box;
}

function confirmStep(box, text, label, action) {
  // Git-changing actions always ask once more, inline.
  const yes = detailButton(label, action, 'danger');
  const no = detailButton('Cancel', () => box.replaceChildren(...box.previous));
  box.previous = [...box.childNodes];
  box.replaceChildren(paragraph(text), detailActions(yes, no));
  yes.focus();
}

async function renderDelivery(card, container, section, pre) {
  const nodes = [];
  const inactive = ['todo', 'done'].includes(card.column);
  if (card.completion) {
    const done = card.completion;
    nodes.push(section('Completed', paragraph(done.kind === 'merged'
      ? `Merged${done.trigger === 'automation' ? ' automatically (project workflow setting)' : ''} into ${done.targetBranch}: ${short(done.previousTarget)} → ${short(done.mergedCommit)} (${done.method}). Nothing was pushed.`
      : done.kind === 'pull_request' ? `Pull request ${done.number ? `#${done.number} ` : ''}merged on GitHub into ${done.base || 'the target branch'}. Pull ${done.base || 'the target branch'} to update your local checkout.`
      : ['closed', 'unmerged'].includes(done.kind) ? 'Completed on the board. Nothing was merged or pushed; the task branch and worktree are kept.'
      : 'Reviewed: no changes required. Nothing was merged.')));
    if (done.summary) nodes.push(section('Accomplished', pre(done.summary)));
  }
  if (card.workspace?.status !== 'ready') {
    if (!['todo', 'done'].includes(card.column)) {
      const box = section('Finish without changes', paragraph('If review shows that no code change is needed, complete the task without a merge.'));
      box.append(detailActions(detailButton('Reviewed: no changes required…', () => confirmStep(box, 'Complete this task as “no changes required”? It moves to Done and is not described as merged.', 'Complete with no changes', () => deliveryAction(card, 'POST', 'complete-no-changes', { confirm: true }, 'Completed with no changes required.')))));
      nodes.push(box);
    }
    container.replaceChildren(...nodes);
    return;
  }
  const loading = paragraph('Reading the task branch…');
  container.replaceChildren(...nodes, loading);
  let rev;
  try {
    const { response, data } = await api(`/api/tasks/${encodeURIComponent(card.id)}/revision`, { timeoutMs: 20000 });
    if (!response.ok) throw new Error(data.error || 'The task branch could not be read.');
    rev = data.revision;
  } catch (error) { loading.textContent = error.message; return; }
  // Task revision and commit.
  const revision = section('Task revision', paragraph(`Commit ${short(rev.taskCommit)} on ${rev.branch || 'a detached HEAD'} · ${plural(rev.ahead, 'commit')} ahead of ${rev.targetBranch} (${short(rev.targetCommit)}) · ${rev.clean ? 'no uncommitted changes' : plural(rev.changes.length, 'uncommitted change')}.`));
  if (!rev.branchOk) revision.append(paragraph('The worktree is not on its task branch. Promptboard will not commit, review, test, or merge until it is.', 'kanban-error'));
  if (rev.merging && !inactive) {
    // A merge of the target branch (started for the merge agent) is waiting to be committed or aborted.
    revision.append(paragraph(rev.unresolved.length
      ? `A merge of ${rev.targetBranch} into the task branch is in progress. Still conflicted: ${rev.unresolved.join(', ')}. Resolve these (or let the merge agent do it) before you commit.`
      : `A merge of ${rev.targetBranch} into the task branch is in progress${rev.conflicts.length ? `; the conflicts in ${rev.conflicts.join(', ')} have no markers left` : ''}. Check the result, then commit it. Review and tests must run again afterwards.`, rev.unresolved.length ? 'kanban-error' : ''));
    const abort = document.createElement('div');
    abort.append(detailActions(detailButton('Abort merge…', () => confirmStep(abort, `Abort the merge? The task branch returns to ${short(rev.taskCommit)} and every change made during the merge, including conflict resolutions, is discarded.`, 'Abort merge', () => deliveryAction(card, 'POST', 'abort-merge', { confirm: true }, 'Merge aborted; the task branch is unchanged.')))));
    revision.append(abort);
  }
  if (!rev.clean && rev.branchOk && !inactive) {
    const diff = pre('Loading the changes…');
    const label = document.createElement('label'); label.className = 'field-label'; label.textContent = 'Commit message';
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 2000; input.value = rev.merging ? `Merge ${rev.targetBranch} into ${rev.branch}` : card.title; input.id = 'commit-message';
    label.append(input);
    const box = document.createElement('div');
    const commit = detailButton(rev.merging ? 'Commit merge…' : 'Commit task changes…', () => confirmStep(box, `Commit all ${plural(rev.changes.length, 'change')} shown above on ${rev.branch} with your existing Git identity?`, 'Commit', () => deliveryAction(card, 'POST', 'commit', { message: input.value, confirm: true }, rev.merging ? 'Merge committed. Review and test the task again.' : 'Task changes committed.')));
    commit.disabled = rev.unresolved.length > 0;
    box.append(detailActions(commit));
    revision.append(paragraph('Review and testing need a committed revision. Check the changes first:'), diff, label, box);
    api(`/api/tasks/${encodeURIComponent(card.id)}/uncommitted`, { timeoutMs: 20000 }).then(({ data }) => {
      diff.textContent = `${(data.changes || []).join('\n')}\n\n${data.diff || ''}${data.truncated ? '\n[The diff is longer; the rest is in the worktree.]' : ''}`;
    }).catch(() => { diff.textContent = 'The changes could not be read.'; });
  }
  nodes.push(revision);
  // Code review evidence.
  const review = card.evidence?.review;
  if (review) {
    const current = review.taskCommit === rev.taskCommit && rev.clean;
    const box = section('Code review', paragraph(`Review ${review.status.replaceAll('_', ' ')} · verdict ${review.verdict.replaceAll('_', ' ')} · for commit ${short(review.taskCommit)}${current ? '' : ' (stale: the task changed; review again)'}.${review.parsed === false ? ' The findings could not be read in the requested format; see the full text.' : ''}`));
    if (review.findings?.length) {
      const table = document.createElement('table');
      for (const finding of review.findings) {
        const row = document.createElement('tr');
        for (const value of [finding.severity, `${finding.file}${finding.line ? `:${finding.line}` : ''}`, finding.explanation]) { const td = document.createElement('td'); td.textContent = value; row.append(td); }
        table.append(row);
      }
      box.append(table);
    } else if (review.text) box.append(pre(review.text));
    const actions = [];
    if (review.status === 'completed' && current && !inactive) actions.push(detailButton('Accept review', () => deliveryAction(card, 'POST', 'accept-review', {}, 'Review accepted for this commit.'), 'danger'));
    if (['completed', 'accepted'].includes(review.status) && card.column === 'code_review') actions.push(detailButton('Send back to Executing', () => { $('#task-dialog').close(); placeCard(card.id, 'executing', null); }));
    if (actions.length) box.append(detailActions(...actions));
    nodes.push(box);
  } else if (['code_review', 'testing', 'merge'].includes(card.column)) nodes.push(section('Code review', paragraph('No review yet. In Code Review, start a review of the committed diff.')));
  // Tests: only command results decide.
  const project = currentProject();
  const tests = card.evidence?.tests;
  if (['testing', 'merge'].includes(card.column) || tests) {
    const commands = project.testCommands || [];
    const box = section('Tests', paragraph(commands.length ? `Configured: ${commands.map(item => item.argv.join(' ')).join(' · ')}` : 'No test commands yet. Add them in Workflow settings. Promptboard runs only commands you configure.'));
    if (tests) {
      const current = tests.taskCommit === rev.taskCommit && tests.targetCommit === rev.targetCommit;
      box.append(paragraph(`Last run: ${tests.status}${tests.note ? ` (${tests.note})` : ''} · for commit ${short(tests.taskCommit)} against ${short(tests.targetCommit)}${current ? '' : ' (stale: run again)'}.`));
      const table = document.createElement('table');
      for (const result of tests.results || []) {
        const row = document.createElement('tr');
        for (const value of [result.label, result.status, result.exitCode ?? '—', `${(result.durationMs / 1000).toFixed(1)}s`, result.reason || '']) { const td = document.createElement('td'); td.textContent = String(value); row.append(td); }
        table.append(row);
      }
      if (tests.results?.length) box.append(table);
      const failed = (tests.results || []).find(result => result.status !== 'passed' && result.tail);
      if (failed) box.append(pre(failed.tail));
    }
    if (commands.length && tests?.status !== 'running' && !inactive) {
      box.append(detailActions(detailButton('Run tests…', () => confirmStep(box, `Run ${plural(commands.length, 'command')} in the task worktree? Only exit codes decide whether tests passed.`, 'Run tests', async () => {
        if (await deliveryAction(card, 'POST', 'tests', { confirm: true }, 'Tests started.')) pollTests(card.id);
      }))));
    }
    if (tests?.status === 'running' && !inactive) pollTests(card.id);
    nodes.push(box);
  }
  // Merge preview and confirmation.
  if (card.column === 'merge') {
    const box = section('Merge', paragraph('Checking whether a fast-forward merge is possible…'));
    nodes.push(box);
    api(`/api/tasks/${encodeURIComponent(card.id)}/merge-preview`, { timeoutMs: 30000 }).then(({ response, data }) => {
      if (!response.ok) { box.replaceChildren(paragraph(data.error || 'The merge preview failed.', 'kanban-error')); return; }
      const preview = data.preview;
      const parts = [paragraph(`${preview.sourceBranch} → ${preview.targetBranch}: ${short(preview.targetCommit)} → ${short(preview.taskCommit)}. ${preview.targetCheckout ? `The checkout at ${preview.targetCheckout.path} is fast-forwarded.` : 'The branch reference is fast-forwarded; no checkout is switched.'} Nothing is pushed.`)];
      parts.push(pre([`Commits (${preview.commits.length}):`, ...preview.commits.map(commit => `  ${short(commit.sha)} ${commit.subject}`), `Files (${preview.files.length}):`, ...preview.files.map(file => `  ${file}`)].join('\n')));
      if (preview.problems.length) { const list = document.createElement('ul'); for (const problem of preview.problems) { const item = document.createElement('li'); item.textContent = problem; list.append(item); } parts.push(list); }
      const actions = [];
      if (preview.eligible) actions.push(detailButton('Confirm merge…', () => confirmStep(box, `Fast-forward ${preview.targetBranch} to ${short(preview.taskCommit)}? This changes your local ${preview.targetBranch}. It is not pushed.`, 'Confirm merge', () => deliveryAction(card, 'POST', 'merge', { confirm: true, taskCommit: preview.taskCommit, targetCommit: preview.targetCommit }, `Merged into ${preview.targetBranch} and verified. The card is in Done.`)), 'danger'));
      if (!preview.fastForward) actions.push(detailButton('Update task branch…', () => confirmStep(box, `Merge the current ${preview.targetBranch} into the task branch? Conflicts are not resolved automatically; the update is then aborted. Review and tests must run again.`, 'Update task branch', () => deliveryAction(card, 'POST', 'update-branch', { confirm: true }, 'Task branch updated. Review and test it again.'))));
      if (actions.length) parts.push(detailActions(...actions));
      box.replaceChildren(section('Merge').firstChild, ...parts);
    }).catch(() => { box.replaceChildren(paragraph('The merge preview failed.', 'kanban-error')); });
  }
  // Pull request: push the task branch (never forced) and open it on GitHub with gh.
  const pr = card.evidence?.pullRequest;
  if (card.column === 'merge' || pr) {
    const box = section('Pull request');
    if (pr) {
      const line = paragraph(`${pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : 'Open'} · ${pr.branch} → ${pr.base} on ${pr.remote} · for commit ${short(pr.taskCommit)}${pr.taskCommit === rev.taskCommit ? '' : ' (newer commits are not pushed yet)'}. `);
      if (pr.url) line.append(externalLink(pr.url, pr.number ? `#${pr.number}` : 'Open on GitHub'));
      box.append(line);
    } else box.append(paragraph(`Instead of merging locally, push ${rev.branch} and open a pull request into ${rev.targetBranch} with the GitHub CLI (gh). Nothing is pushed until you confirm, and never with --force.`));
    const actions = [];
    if (card.column === 'merge' && rev.clean && rev.ahead && !rev.merging && pr?.state !== 'MERGED') {
      const review = card.evidence?.review, tests = card.evidence?.tests;
      const title = document.createElement('input'); title.type = 'text'; title.maxLength = 256; title.value = card.title; title.setAttribute('aria-label', 'Pull request title');
      const body = document.createElement('textarea'); body.maxLength = 20000; body.setAttribute('aria-label', 'Pull request description');
      body.value = [`Task: ${card.title}`, '', `Code review: ${review ? `${review.status.replaceAll('_', ' ')} (${review.verdict.replaceAll('_', ' ')}) for ${short(review.taskCommit)}` : 'none'}`,
        `Tests: ${tests ? `${tests.status} for ${short(tests.taskCommit)}` : 'not run'}`, '', 'Opened with Promptboard.'].join('\n');
      const form = document.createElement('div'); form.className = 'pr-fields';
      const titleLabel = document.createElement('label'); titleLabel.className = 'field-label'; titleLabel.textContent = 'Title'; titleLabel.append(title);
      const bodyLabel = document.createElement('label'); bodyLabel.className = 'field-label'; bodyLabel.textContent = 'Description (sent to GitHub; the task prompt is not included unless you add it)'; bodyLabel.append(body);
      form.append(titleLabel, bodyLabel);
      box.append(form);
      actions.push(detailButton(pr?.state === 'OPEN' ? 'Push new commits…' : 'Open pull request…', () => confirmStep(box, `Push ${rev.branch} to the repository's remote and ${pr?.state === 'OPEN' ? 'update the open pull request' : `open a pull request into ${rev.targetBranch}`}? This publishes the task branch. It is never force-pushed.`, pr?.state === 'OPEN' ? 'Push' : 'Push and open', () => deliveryAction(card, 'POST', 'pull-request', { confirm: true, title: title.value, body: body.value }, 'Pull request ready on GitHub.')), 'danger'));
    }
    if (pr?.url && pr.state !== 'MERGED') actions.push(detailButton('Check pull request', () => deliveryAction(card, 'POST', 'pull-request-status', {}, 'Pull request status updated. A merged pull request moves the card to Done.')));
    if (actions.length) box.append(detailActions(...actions));
    nodes.push(box);
  }
  // No-change completion and cleanup.
  if (rev.clean && !rev.ahead && !['todo', 'done'].includes(card.column)) {
    const box = section('Finish without changes', paragraph('The task branch has no changes. If none are needed, complete the task without a merge.'));
    box.append(detailActions(detailButton('Reviewed: no changes required…', () => confirmStep(box, 'Complete this task as “no changes required”? It is not described as merged.', 'Complete with no changes', () => deliveryAction(card, 'POST', 'complete-no-changes', { confirm: true }, 'Completed with no changes required.')))));
    nodes.push(box);
  }
  // Start over: retire this attempt (its branch stays untouched) and run the task again from a fresh branch.
  if (card.workspace?.status === 'ready' && card.column !== 'done') nodes.push(startOverSection(card, section, rev));
  if (card.column === 'done') {
    const box = section('Worktree', paragraph(`The worktree at ${card.workspace.path} is no longer needed. Removing it keeps the branch ${card.workspace.branch}. A worktree with uncommitted changes is never removed.`));
    box.append(detailActions(detailButton('Remove worktree…', () => confirmStep(box, 'Remove this task worktree? The branch stays.', 'Remove worktree', () => deliveryAction(card, 'DELETE', 'worktree', undefined, 'Worktree removed; the branch was kept.')))));
    nodes.push(box);
  }
  container.replaceChildren(...nodes);
}

function pollTests(taskId) {
  if (pollTests.timer) return;
  pollTests.timer = setTimeout(async () => {
    pollTests.timer = null;
    await loadBoard();
    const card = findTask(taskId);
    if ($('#task-dialog').open && $('#task-dialog').dataset.taskId === taskId && card) openTaskDetails(taskId);
  }, 1500);
}

// ---- Repository link and target branch ----

// Kanban sidebar: one entry per project, each with its own board. Selecting one only changes
// which board is shown; runs belong to the server and continue in every project.
// Each entry has a ⋯ menu: rename (inline), repository, workflow settings, delete (inline confirm).
let workspaceMenu = null; // { id, mode: 'menu' | 'rename' | 'delete', draft, error }
function setWorkspaceMenu(value) { workspaceMenu = value; renderWorkspace(currentProject()); }
function openProjectSection(id, then) {
  if (id !== currentProject()?.id) selectProject(id);
  setWorkspaceMenu(null);
  setSidebar(false);
  setProjectCollapsed(false, false);
  then();
}
async function renameFromSidebar(project, name) {
  const error = projectNameError(name.trim(), project.id);
  if (error) { setWorkspaceMenu({ ...workspaceMenu, error }); return; }
  try { await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}`, { name: name.trim(), expectedRevision: project.revision }); }
  catch (failure) { setWorkspaceMenu({ ...workspaceMenu, error: failure.message }); return; }
  setWorkspaceMenu(null);
  announce(`Renamed “${project.name}” to “${name.trim()}”.`);
}
function workspaceMenuFor(project, card) {
  const box = document.createElement('div');
  box.className = 'workspace-menu';
  box.id = `workspace-menu-${project.id}`;
  const mode = workspaceMenu.mode;
  if (mode === 'rename') {
    const form = document.createElement('form');
    form.className = 'workspace-rename';
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 80; input.value = workspaceMenu.draft ?? project.name; input.setAttribute('aria-label', `New name for ${project.name}`);
    input.addEventListener('input', () => { workspaceMenu.draft = input.value; });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); setWorkspaceMenu(null); card.focus(); } });
    form.addEventListener('submit', event => { event.preventDefault(); renameFromSidebar(project, input.value); });
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save'; save.className = 'danger';
    form.append(input, detailActions(save, detailButton('Cancel', () => setWorkspaceMenu(null))));
    box.append(form);
    if (workspaceMenu.error) box.append(paragraph(workspaceMenu.error, 'kanban-error'));
    setTimeout(() => { if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest?.('.workspace-menu-toggle, .workspace-menu, .workspace-rename')) input.focus(); });
  } else if (mode === 'delete') {
    box.append(paragraph(`Delete “${project.name}” and its ${plural(project.tasks.length, 'card')}? This cannot be undone. Export a backup first if you want to keep them.`),
      detailActions(detailButton('Delete project', () => { setWorkspaceMenu(null); deleteProject(project); }, 'danger'), detailButton('Keep', () => setWorkspaceMenu(null))));
  } else {
    const item = (label, action, className = '') => { const button = detailButton(label, action, className); button.setAttribute('role', 'menuitem'); return button; };
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-label', `Manage ${project.name}`);
    box.append(
      item('Rename', () => setWorkspaceMenu({ id: project.id, mode: 'rename' })),
      item(project.repository ? 'Change repository…' : 'Link repository…', () => openProjectSection(project.id, () => { repoPanelOpen = true; renderRepository(currentProject()); $('#repo-path').focus(); })),
      item('Workflow settings…', () => openProjectSection(project.id, openWorkflowDialog)),
      item('Delete…', () => setWorkspaceMenu({ id: project.id, mode: 'delete' }), 'workspace-delete'));
  }
  return box;
}
function renderWorkspace(current) {
  const projects = board?.projects || [];
  if (workspaceMenu && !projects.some(project => project.id === workspaceMenu.id)) workspaceMenu = null;
  $('#workspace-count').textContent = String(projects.length).padStart(2, '0');
  $('#workspace-empty').hidden = projects.length > 0;
  $('#workspace-new').disabled = !board;
  $('#workspace-open').disabled = !board;
  $('#workspace-list').replaceChildren(...projects.map(project => {
    const ids = new Set(project.tasks.map(task => task.id));
    const live = (board.runs || []).filter(run => ids.has(run.taskId) && RUN_LIVE.includes(run.status));
    const waiting = live.filter(run => run.status === 'waiting_for_input').length;
    const item = document.createElement('li');
    item.className = 'workspace-entry';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-item';
    if (project.id === current?.id) { button.setAttribute('aria-current', 'true'); item.classList.add('current'); }
    const name = document.createElement('span'); name.className = 'workspace-name'; name.textContent = project.name;
    const repo = project.repository ? project.repository.root.split(/[\\/]/).pop() + (project.targetBranch ? ` → ${project.targetBranch.name}` : '') : 'Not linked';
    const meta = document.createElement('span'); meta.className = 'workspace-meta';
    meta.textContent = `${repo} · ${project.tasks.length} ${project.tasks.length === 1 ? 'card' : 'cards'}`;
    button.append(name, meta);
    if (live.length) {
      const status = document.createElement('span');
      status.className = `workspace-live${waiting ? ' waiting' : ''}`;
      status.textContent = waiting ? `${waiting} waiting` : `${live.length} running`;
      button.append(status);
    }
    button.title = [project.name, project.repository?.root, live.length ? `${live.length} active agent ${live.length === 1 ? 'run' : 'runs'}` : ''].filter(Boolean).join('\n');
    button.addEventListener('click', () => { if (project.id !== current?.id) selectProject(project.id); setSidebar(false); });
    const open = workspaceMenu?.id === project.id;
    const toggle = detailButton('⋯', () => setWorkspaceMenu(open ? null : { id: project.id, mode: 'menu' }), 'workspace-menu-toggle');
    toggle.setAttribute('aria-label', `Manage project: ${project.name}`);
    toggle.title = 'Rename, repository, workflow, delete';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-controls', `workspace-menu-${project.id}`);
    item.append(button, toggle);
    if (open) { item.classList.add('menu-open'); item.append(workspaceMenuFor(project, button)); }
    return item;
  }));
}

function renderRepository(project) {
  // The repository form opens when the project is not linked, or when the user asks for it.
  $('#repo-panel').hidden = !project || (Boolean(project.repository) && !repoPanelOpen && !project.pendingImport);
  $('#repo-edit').setAttribute('aria-expanded', String(!$('#repo-panel').hidden));
  $('#repo-summary').textContent = !project ? '—' : project.repository ? project.repository.root : 'Not linked';
  $('#repo-summary').title = project?.repository?.root || '';
  $('#workflow-summary').textContent = project ? workflowSummary(project) : '—';
  $('#workflow-open').disabled = !project;
  $('#repo-edit').disabled = !project;
  if (!project) { $('#branch-field').hidden = true; return; }
  if (repoFormFor !== project.id) {
    repoFormFor = project.id;
    $('#repo-path').value = project.repository?.path || '';
    $('#repo-message').hidden = true;
    $('#repo-setup').hidden = true;
  }
  const repository = project.repository;
  $('#repo-state').textContent = repository
    ? `Linked to ${repository.root}${repository.linkedWorktree ? ' (a linked worktree)' : ''}.`
    : 'Not linked. Cards can wait in To Do, but they cannot move on or run agents until the project is linked to a Git repository.';
  $('#repo-unlink').hidden = !repository;
  $('#branch-field').hidden = !repository;
  const known = repositories.get(project.id);
  const branches = known?.branches || (project.targetBranch ? [{ name: project.targetBranch.name }] : []);
  $('#target-branch').replaceChildren(option('', branches.length ? 'Choose a local branch…' : 'Reading branches…'), ...branches.map(branch => option(branch.name, branch.name)));
  $('#target-branch').value = project.targetBranch?.name || '';
  $('#branch-save').disabled = !repository;
  $('#branch-state').textContent = project.targetBranch
    ? `Target branch: ${project.targetBranch.name} at ${project.targetBranch.commit.slice(0, 12)}. Task worktrees start from this recorded commit.`
    : 'No target branch yet. Choose the local branch that task branches start from.';
  if (repository && !known) refreshBranches(project.id);
  const pending = project.pendingImport;
  $('#import-pending').hidden = !pending;
  if (pending) {
    const automatic = Object.entries(pending.workflow || {}).filter(([, settings]) => settings?.policy === 'start').map(([stage]) => columnTitle(stage));
    const parts = [pending.repositoryPath && `repository ${pending.repositoryPath}`, pending.targetBranch && `target branch ${pending.targetBranch}`,
      pending.agentDefaults && `project agent ${agentText(pending.agentDefaults)}`, pending.workflow && `workflow settings${automatic.length ? ` (automatic runs in ${automatic.join(' and ')})` : ''}`, pending.testCommands?.length && `${plural(pending.testCommands.length, 'test command')}`].filter(Boolean);
    $('#import-pending-text').textContent = `The imported backup suggests ${parts.join(', ')}. Nothing is applied until you confirm.`;
  }
}

async function refreshBranches(projectId) {
  repositories.set(projectId, { branches: [] });
  try {
    const { response, data } = await api(`/api/projects/${encodeURIComponent(projectId)}/branches`, { timeoutMs: 30000 });
    if (!response.ok) throw new Error(data.error || 'The branches could not be read.');
    repositories.set(projectId, data.repository);
  } catch (error) {
    repositories.delete(projectId);
    if (currentProject()?.id === projectId) repoMessage(error.message);
    return;
  }
  if (currentProject()?.id === projectId) renderRepository(currentProject());
}

function repoMessage(message) { $('#repo-message').textContent = message; $('#repo-message').hidden = !message; }

// A folder that is not a repository yet (or has no commits, or does not exist) can be set up
// from here, but only after the user confirms exactly what will happen.
const GIT_SETUP_STEPS = { PATH_NOT_FOUND: ['create this folder', 'run git init'], NOT_A_REPOSITORY: ['run git init'], NO_COMMITS: [] };
function offerGitSetup(path, code) {
  const box = $('#repo-setup');
  const steps = GIT_SETUP_STEPS[code];
  if (!steps || !path) { box.hidden = true; return; }
  const all = [...steps, 'make one empty commit named “Initial commit”'];
  const text = all.length > 2 ? `${all.slice(0, -1).join(', ')}, and ${all.at(-1)}` : all.join(' and ');
  const go = detailButton('Set up Git here', () => setUpRepository(path), 'danger');
  box.replaceChildren(paragraph(`Set up Git in ${path}? Promptboard will ${text}, then link the project. Your files are not added or committed.`),
    detailActions(go, detailButton('Cancel', () => { box.hidden = true; $('#repo-path').focus(); })));
  box.hidden = false;
}

async function setUpRepository(path) {
  const project = currentProject();
  if (!project) return;
  repoMessage('');
  try {
    const result = await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/init-repository`, { path, confirm: true, expectedRevision: project.revision }, 60000);
    $('#repo-setup').hidden = true;
    if (result.repository) repositories.set(project.id, result.repository);
    renderRepository(currentProject());
    announce(`${result.setup?.createdFolder ? 'Created the folder, initialized Git' : result.setup?.initialized ? 'Initialized Git' : 'Added an empty first commit'} and linked “${project.name}”. Choose the target branch next.`);
  } catch (error) { repoMessage(error.message); }
}

async function linkRepository(path) {
  const project = currentProject();
  if (!project) return;
  repoMessage('');
  $('#repo-setup').hidden = true;
  $('#repo-link').disabled = true;
  try {
    const result = await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/repository`, { path, expectedRevision: project.revision }, 60000);
    if (result.repository) repositories.set(project.id, result.repository); else repositories.delete(project.id);
    renderRepository(currentProject());
    announce(path === null ? `Unlinked “${project.name}”.` : `Linked “${project.name}” to ${result.repository.root}. Choose the target branch next.`);
  } catch (error) { repoMessage(error.message); offerGitSetup(path?.trim(), error.code); }
  finally { $('#repo-link').disabled = false; }
}

async function saveTargetBranch() {
  const project = currentProject();
  const branch = $('#target-branch').value;
  if (!project || !branch) { repoMessage('Choose a local branch.'); return; }
  try {
    await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/target-branch`, { branch, expectedRevision: project.revision });
    repoMessage('');
    announce(`Target branch set to ${branch}.`);
  } catch (error) { repoMessage(error.message); }
}

async function confirmImported(accept) {
  const project = currentProject();
  if (!project) return;
  try {
    await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/confirm-import`, { accept, expectedRevision: project.revision }, 60000);
    repositories.delete(project.id);
    renderRepository(currentProject());
    announce(accept ? 'Imported settings confirmed.' : 'Imported settings dismissed.');
  } catch (error) { repoMessage(error.message); }
}

// ---- Backup ----

async function exportBoard() {
  let backup;
  try {
    const { response, data } = await api(`/api/board/export${$('#export-base-content')?.checked ? '?includeBaseContent=true' : ''}`, { timeoutMs: 60000 });
    if (!response.ok) throw new Error(data.error || 'The board could not be exported.');
    backup = data;
  } catch (error) { showBoardError(error); return; }
  downloadFile(`${JSON.stringify(backup, null, 2)}\n`, 'application/json;charset=utf-8', `promptboard-backup-${new Date().toISOString().slice(0, 10)}.json`);
  announce(`Board backup exported: ${boardCounts(backup.projects)}.`);
}

async function importBoard() {
  const file = $('#import-file').files?.[0];
  $('#import-file').value = '';
  if (!file || !board) return;
  closeProjectForm();
  const failed = message => {
    showProjectDetail(paragraph(`Import failed. Your board is unchanged. ${message}`, 'kanban-error'));
    announce(`Import failed. Your board is unchanged. ${message}`);
  };
  let data;
  if (file.size > IMPORT_LIMIT_BYTES) { failed('The file is larger than 20 MB.'); return; }
  try { data = JSON.parse(await file.text()); } catch { failed('The file is not valid JSON.'); return; }
  if (!['kanban-backup', 'promptboard-backup'].includes(data?.kind)) { failed('The file is not a Promptboard or Kanban backup.'); return; }
  const counts = boardCounts(Array.isArray(data.projects) ? data.projects : [], data.kind === 'kanban-backup' ? 'cards' : 'tasks');
  const replace = async confirmed => {
    try { await boardCall('POST', '/api/board/import', { backup: data, replace: confirmed }, 120000); }
    catch (error) { failed(error.message); return; }
    savePref(SELECTED_PROJECT_KEY, board.projects.find(project => project.id === data.selectedProjectId)?.id || board.projects[0]?.id || '');
    renderBoard();
    const message = `Backup imported: ${boardCounts(board.projects)}. No agent runs were started.${board.projects.some(project => project.pendingImport) ? ' Imported repository paths and workflow settings wait for your confirmation.' : ''}`;
    showProjectDetail(paragraph(message));
    announce(message);
  };
  if (!board.projects.length) { await replace(false); return; }
  const keep = detailButton('Keep current board', () => { showProjectDetail(); announce('Import canceled. Your board is unchanged.'); });
  showProjectDetail(
    paragraph(`Replace the current board (${boardCounts(board.projects)}) with this backup (${counts})? The current board is removed. Export it first if you want to keep it.`),
    detailActions(detailButton('Replace board', () => replace(true), 'danger'), keep),
  );
  keep.focus();
}

// ---- Add to Kanban from Compose ----

function openAddToKanban() {
  if (!currentResult || running) return;
  const source = snapshotSource(currentResult);
  const projects = board?.projects || [];
  $('#add-project').replaceChildren(...projects.map(project => option(project.id, project.name)), option('', 'New project…'));
  $('#add-project').value = currentProject()?.id || '';
  $('#add-project-name').value = '';
  $('#add-project-name-field').hidden = Boolean($('#add-project').value);
  $('#add-title').value = currentResult.input.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Generated prompt';
  $('#add-preview').textContent = currentResult.prompt;
  $('#add-note').textContent = `The exact prompt below is copied into a To Do card (${currentResult.prompt.length.toLocaleString()} characters). Later card edits do not change your prompt history. Source: ${sourceSummary(source)} · ${cardStatus({ source, checksOutdated: false }).text}.`;
  $('#add-error').hidden = true;
  $('#add-dialog').showModal();
  $(projects.length ? '#add-title' : '#add-project-name').focus();
}

async function addToKanban(event) {
  event.preventDefault();
  if (!board) await (boardLoading || loadBoard());
  const result = currentResult;
  const title = $('#add-title').value.trim();
  const name = $('#add-project-name').value.trim();
  let project = board?.projects.find(item => item.id === $('#add-project').value);
  const error = !board ? 'The board is not loaded. Check that the app is running, then try again.'
    : !result || !result.prompt.trim() ? 'There is no prompt to add.' : !title ? 'Enter a short card title.' : title.length > 120 ? 'Use a title of at most 120 characters.'
    : project ? '' : projectNameError(name);
  const showError = message => { $('#add-error').textContent = message; $('#add-error').hidden = false; };
  if (error) { showError(error); return; }
  try {
    project ||= (await boardCall('POST', '/api/projects', { name })).project;
    savePref(SELECTED_PROJECT_KEY, project.id);
    if (![...$('#add-project').options].some(option => option.value === project.id)) $('#add-project').prepend(option(project.id, project.name));
    $('#add-project').value = project.id; $('#add-project-name-field').hidden = true;
    await boardCall('POST', '/api/tasks', { projectId: project.id, title, prompt: result.prompt, source: snapshotSource(result) });
  } catch (failure) { showError(failure.message); return; }
  $('#add-dialog').close();
  announce(`Added “${title}” to To Do in ${project.name}.`);
  $('#kanban-label').textContent = 'Added!';
  setTimeout(() => { $('#kanban-label').textContent = 'Add to Kanban'; }, 1800);
  $('#kanban-button').focus();
}
window.addEventListener('hashchange', showPage);
// The skip link must not change the hash, which selects the page.
$('#skip-link').addEventListener('click', event => { event.preventDefault(); ($(currentPage() === 'base' ? '#base-view' : currentPage() === 'kanban' ? '#kanban-view' : '#prompt-input')).focus(); });
$('#kanban-button').addEventListener('click', openAddToKanban);

// ---- Split into tasks (optional) ----
// One CLI call proposes smaller tasks; nothing is saved until you add them. The cards keep the order
// shown, and Autopilot can take them in that order after you review and start it.
const split = { tasks: [], controller: null };
function renderSplit() {
  const list = $('#split-list');
  list.replaceChildren(...split.tasks.map((task, index) => {
    const item = document.createElement('li');
    item.className = `split-item${task.included ? '' : ' excluded'}`;
    const include = document.createElement('input'); include.type = 'checkbox'; include.checked = task.included; include.setAttribute('aria-label', `Include task ${index + 1}`);
    include.addEventListener('change', () => { task.included = include.checked; renderSplit(); });
    const title = document.createElement('input'); title.className = 'split-title'; title.maxLength = 120; title.value = task.title; title.setAttribute('aria-label', `Title of task ${index + 1}`);
    title.addEventListener('input', () => { task.title = title.value; });
    const move = (step, label) => { const button = detailButton(step < 0 ? '↑' : '↓', () => { const [moved] = split.tasks.splice(index, 1); split.tasks.splice(index + step, 0, moved); renderSplit(); list.children[index + step]?.querySelector(step < 0 ? '.split-up' : '.split-down')?.focus(); }, `icon-button ${step < 0 ? 'split-up' : 'split-down'}`); button.setAttribute('aria-label', `${label}: task ${index + 1}`); button.disabled = step < 0 ? index === 0 : index === split.tasks.length - 1; return button; };
    const tools = document.createElement('div'); tools.className = 'split-tools'; tools.append(include, move(-1, 'Move up'), move(1, 'Move down'));
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = `Task prompt (${task.prompt.length.toLocaleString()} characters)`;
    const text = document.createElement('textarea'); text.value = task.prompt; text.setAttribute('aria-label', `Prompt of task ${index + 1}`);
    text.addEventListener('input', () => { task.prompt = text.value; });
    details.append(summary, text);
    item.append(tools, title, details);
    return item;
  }));
  const count = split.tasks.filter(task => task.included).length;
  $('#split-add').disabled = !count;
  $('#split-add').firstChild.textContent = `Add ${plural(count, 'card')} to To Do `;
}
async function openSplit() {
  if (!currentResult || running) return;
  if (!board) await (boardLoading || loadBoard()).catch(() => {});
  const result = currentResult;
  split.tasks = []; split.result = result; split.savedIds = [];
  $('#split-project').disabled = false;
  $('#split-list').replaceChildren();
  $('#split-error').hidden = true; $('#split-coverage').hidden = true; $('#split-target').hidden = true; $('#split-autopilot-field').hidden = true;
  $('#split-add').disabled = true;
  $('#split-status').textContent = `${providerInfo[result.provider]?.name || result.provider} is splitting the prompt into tasks… This is one CLI call.`;
  $('#split-dialog').showModal();
  split.controller = new AbortController();
  let answer;
  try { answer = await api('/api/split', { method: 'POST', body: { prompt: result.prompt, provider: result.provider, model: result.model || '', effort: result.effort || '', language: result.language || 'en' }, timeoutMs: 200000, signal: split.controller.signal }); }
  catch { if (!split.controller.signal.aborted) $('#split-status').textContent = 'The app did not answer. Check that Promptboard is still running.'; return; }
  if (split.controller.signal.aborted || !$('#split-dialog').open) return;
  const { response, data } = answer;
  if (!response.ok) { $('#split-status').textContent = ''; $('#split-error').textContent = data.error || 'The prompt could not be split.'; $('#split-error').hidden = false; return; }
  split.tasks = data.tasks.map(task => ({ ...task, included: true }));
  $('#split-status').textContent = `${plural(split.tasks.length, 'task')}, in the order they run. Edit, reorder, or leave out tasks, then add them as To Do cards.`;
  const coverage = data.coverage;
  if (coverage?.issues?.length) {
    $('#split-coverage').textContent = `Check before adding: ${coverage.issues.length === 1 ? 'this exact text from your prompt is' : 'these exact texts from your prompt are'} in no task: ${coverage.issues.map(issue => issue.excerpt || issue.message).slice(0, 5).join(' · ')}`;
    $('#split-coverage').className = 'note kanban-error'; $('#split-coverage').hidden = false;
  } else if (coverage?.protectedCount) { $('#split-coverage').textContent = `All ${coverage.protectedCount} exact texts found in your prompt (paths, code, quotes) appear in the tasks.`; $('#split-coverage').className = 'note'; $('#split-coverage').hidden = false; }
  const projects = board?.projects || [];
  $('#split-project').replaceChildren(...projects.map(project => option(project.id, project.name)), option('', 'New project…'));
  $('#split-project').value = currentProject()?.id || '';
  $('#split-project-name-field').hidden = Boolean($('#split-project').value);
  $('#split-target').hidden = false; $('#split-autopilot-field').hidden = false;
  renderSplit();
  $('#split-add').focus();
}
async function addSplitCards(event) {
  event.preventDefault();
  const chosen = split.tasks.filter(task => task.included);
  if (!chosen.length) return;
  const showError = message => { $('#split-error').textContent = message; $('#split-error').hidden = false; };
  const bad = chosen.findIndex(task => !task.title.trim() || task.title.length > 120 || !task.prompt.trim());
  if (bad >= 0) { showError(`Task ${split.tasks.indexOf(chosen[bad]) + 1} needs a title (at most 120 characters) and a prompt.`); return; }
  let project = board?.projects.find(item => item.id === $('#split-project').value);
  const name = $('#split-project-name').value.trim();
  if (!project) { const error = projectNameError(name); if (error) { showError(error); return; } }
  $('#split-add').disabled = true;
  const ids = [];
  try {
    project ||= (await boardCall('POST', '/api/projects', { name })).project;
    savePref(SELECTED_PROJECT_KEY, project.id);
    if (![...$('#split-project').options].some(option => option.value === project.id)) $('#split-project').prepend(option(project.id, project.name));
    $('#split-project').value = project.id; $('#split-project-name-field').hidden = true;
    for (const task of chosen) {
      const saved = await boardCall('POST', '/api/tasks', { projectId: project.id, title: task.title.trim(), prompt: task.prompt, source: snapshotSource(split.result) });
      ids.push(saved.task.id); split.savedIds.push({ id: saved.task.id, projectId: project.id });
      split.tasks = split.tasks.filter(item => item !== task);
    }
  } catch (failure) {
    renderSplit();
    showError(`${failure.message}${split.savedIds.length ? ` ${plural(split.savedIds.length, 'card')} already saved. Only unsaved tasks remain below.` : ''}`);
    return;
  }
  $('#split-dialog').close();
  announce(`Added ${plural(ids.length, 'card')} to To Do in ${project.name}, in order.`);
  if ($('#split-autopilot').checked) {
    if (location.hash !== '#/kanban') location.hash = '#/kanban';
    await loadBoard();
    openAutopilot({ first: split.savedIds.filter(item => item.projectId === project.id).map(item => item.id) });
  }
}
$('#split-button').addEventListener('click', openSplit);
// Lock a modal while a save is in flight: repeated Enter/clicks cannot create duplicates.
function bindAsyncForm(selector, handler) {
  const form = $(selector), dialog = form.closest('dialog');
  let saving = false;
  dialog?.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || form.querySelector('[type="submit"]')?.disabled) return;
    saving = true; form.setAttribute('aria-busy', 'true');
    const controls = [...(dialog || form).querySelectorAll('input, textarea, select, button')].map(control => [control, control.disabled]);
    for (const [control] of controls) control.disabled = true;
    try { await handler(event); }
    finally { saving = false; form.setAttribute('aria-busy', 'false'); for (const [control, disabled] of controls) control.disabled = disabled; }
  });
}
bindAsyncForm('#split-form', addSplitCards);
$('#split-project').addEventListener('change', () => { $('#split-project-name-field').hidden = Boolean($('#split-project').value); });
for (const id of ['#split-cancel', '#split-close']) $(id).addEventListener('click', () => { split.controller?.abort(); $('#split-dialog').close(); });
$('#split-dialog').addEventListener('close', () => split.controller?.abort());
bindAsyncForm('#add-form', addToKanban);
$('#add-project').addEventListener('change', () => { $('#add-project-name-field').hidden = Boolean($('#add-project').value); });
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#add-dialog-close').addEventListener('click', () => $('#add-dialog').close());
function selectProject(id) {
  savePref(SELECTED_PROJECT_KEY, id);
  closeProjectForm();
  showProjectDetail();
  renderBoard();
  announce(`Showing project “${currentProject()?.name}”. Agents in other projects keep running.`);
}
$('#project-select').addEventListener('change', () => selectProject($('#project-select').value));
$('#workspace-new').addEventListener('click', () => { setSidebar(false); openProjectForm('new'); });

// Open a folder as a project. The system folder picker supplies the absolute path (a browser page
// cannot); without a picker, the path is typed. A folder that a project already uses is selected.
async function pickFolder() {
  try { const result = await boardCall('POST', '/api/folder/choose', {}, 11 * 60 * 1000); return result.cancelled ? null : result.path; }
  catch (error) {
    if (error.code === 'PICKER_UNAVAILABLE') return undefined;
    showBoardError(error);
    return null;
  }
}
function uniqueProjectName(base) {
  const name = (base || 'Project').slice(0, 72);
  for (let n = 1; ; n++) { const candidate = n === 1 ? name : `${name} ${n}`; if (!projectNameError(candidate)) return candidate; }
}
async function openFolderAsProject(path) {
  path = String(path || '').trim();
  const pathError = message => { $('#workspace-path-form').hidden = false; $('#workspace-path').value = path; $('#workspace-path-error').textContent = message; $('#workspace-path-error').hidden = false; $('#workspace-path').focus(); };
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) { pathError('Enter the absolute path of the project folder.'); return; }
  const clean = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
  const existing = board.projects.find(project => project.repository && [project.repository.path, project.repository.root].map(item => item.replace(/[\\/]+$/, '')).includes(clean));
  $('#workspace-path-form').hidden = true;
  setSidebar(false);
  if (existing) { selectProject(existing.id); announce(`“${existing.name}” already uses this folder. Showing its board.`); return; }
  // A folder that is not a Git repository yet gets git init and an empty first commit (its files are not added).
  let result;
  try { result = await boardCall('POST', '/api/projects', { name: uniqueProjectName(clean.split(/[\\/]/).pop()), folder: clean }); }
  catch (error) { pathError(error.message); return; }
  selectProject(result.project.id);
  announce(`Opened ${clean} as “${result.project.name}”${result.initialized ? '. Git was set up there with an empty first commit; your files were not added' : ''}. Target branch: ${result.project.targetBranch?.name || 'choose one in the repository section'}.`);
}
$('#workspace-open').addEventListener('click', async () => {
  $('#workspace-path-error').hidden = true;
  const path = await pickFolder();
  if (path === undefined) { $('#workspace-path-form').hidden = false; $('#workspace-path').focus(); return; }
  if (path) await openFolderAsProject(path);
});
$('#workspace-path-form').addEventListener('submit', event => { event.preventDefault(); openFolderAsProject($('#workspace-path').value); });
$('#workspace-path-cancel').addEventListener('click', () => { $('#workspace-path-form').hidden = true; $('#workspace-path-error').hidden = true; });
$('#repo-browse').addEventListener('click', async () => {
  const path = await pickFolder();
  if (path === undefined) { repoMessage('This computer has no folder picker Promptboard can use. Type or paste the folder path instead.'); $('#repo-path').focus(); return; }
  if (path) { $('#repo-path').value = path; linkRepository(path); }
});
$('#project-new').addEventListener('click', () => openProjectForm('new'));
$('#project-rename').addEventListener('click', () => openProjectForm('rename'));
$('#project-delete').addEventListener('click', confirmProjectDelete);
$('#project-form').addEventListener('submit', saveProject);
$('#project-cancel').addEventListener('click', closeProjectForm);
$('#repo-form').addEventListener('submit', event => { event.preventDefault(); linkRepository($('#repo-path').value); });
$('#repo-unlink').addEventListener('click', () => linkRepository(null));
$('#branch-save').addEventListener('click', saveTargetBranch);
$('#branch-refresh').addEventListener('click', () => { const project = currentProject(); if (project?.repository) { repositories.delete(project.id); renderRepository(project); } });
$('#repo-edit').addEventListener('click', () => { repoPanelOpen = $('#repo-panel').hidden; renderRepository(currentProject()); if (repoPanelOpen) $('#repo-path').focus(); });
$('#workflow-open').addEventListener('click', openWorkflowDialog);
$('#agents-open').addEventListener('click', () => openWorkflowDialog());
$('#workflow-form').addEventListener('submit', saveWorkflow);
$('#workflow-cancel').addEventListener('click', () => $('#workflow-dialog').close());
$('#workflow-dialog-close').addEventListener('click', () => $('#workflow-dialog').close());
$('#task-dialog-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog-done').addEventListener('click', () => $('#task-dialog').close());
$('#import-confirm').addEventListener('click', () => confirmImported(true));
$('#import-dismiss').addEventListener('click', () => confirmImported(false));
$('#card-new').addEventListener('click', () => openCard());
$('#card-refine').addEventListener('click', () => {
  const prompt = $('#card-prompt').value;
  if (!prompt.trim() || prompt.length > 100000) {
    $('#card-error').textContent = 'Enter a prompt of at most 100,000 characters for Composer.';
    $('#card-error').hidden = false;
    return;
  }
  if (running) return;
  $('#prompt-input').value = prompt;
  $('#prompt-input').dispatchEvent(new Event('input', { bubbles: true }));
  $('#card-dialog').close();
  currentId = null;
  clearOutput();
  renderHistory();
  location.hash = '#/';
  showPage();
  $('#prompt-input').focus();
});
$('#prompt-edit').addEventListener('click', () => {
  if (!currentResult || running) return;
  $('#prompt-edit').disabled = true;
  $('#prompt-edit-text').value = currentResult.prompt;
  $('#prompt-editor').hidden = false;
  $('#prompt-output').hidden = true;
  for (const id of ['kanban-button', 'split-button', 'copy-button', 'export-button']) $(`#${id}`).disabled = true;
  $('#prompt-edit-text').focus();
});
$('#prompt-edit-cancel').addEventListener('click', () => { showResult(currentResult); $('#prompt-edit').focus(); });
$('#prompt-edit-save').addEventListener('click', () => {
  const typed = $('#prompt-edit-text').value;
  if (!typed.trim() || new TextEncoder().encode(typed).byteLength > MAX_PROMPT_BYTES) {
    $('#prompt-edit-error').textContent = 'Enter a prompt within the 2 MiB limit.';
    $('#prompt-edit-error').hidden = false;
    return;
  }
  const changed = typed !== currentResult.prompt.replace(/\r\n?/g, '\n');
  const result = changed ? { ...currentResult, prompt: typed, verification: null, lint: { wordCount: typed.trim().split(/\s+/).length, warnings: [{ message: 'This edited prompt has not been checked by the engine.' }] } } : currentResult;
  history = history.map(entry => entry.id === result.id ? result : entry);
  const saved = persistHistory();
  showResult(result);
  renderHistory();
  announce(saved ? 'Prompt saved. Kanban and Task Split will use this version.' : 'Prompt updated. Browser history was not saved; copy or export it to keep it.');
  $('#prompt-edit').focus();
});

bindAsyncForm('#card-form', saveCard);
$('#card-cancel').addEventListener('click', () => $('#card-dialog').close());
$('#card-dialog-close').addEventListener('click', () => $('#card-dialog').close());
$('#done-dialog-close').addEventListener('click', () => $('#done-dialog').close());
$('#export-board').addEventListener('click', exportBoard);
$('#import-board').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', importBoard);

$('#prompt-form').addEventListener('submit', generate);
$('#prompt-input').addEventListener('input', updateCount);
$('#provider').addEventListener('change', () => { updateProviderState(); authInfo = null; loadAuth(); loadModels(); });
$('#model').addEventListener('change', () => updateEffort());
$('#custom-model').addEventListener('input', () => updateEffort($('#effort').value));
$('#effort').addEventListener('change', () => updateEffort($('#effort').value));
$('#refresh-models').addEventListener('click', () => loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: true }));
for (const button of document.querySelectorAll('input[name="language"]')) button.addEventListener('change', updateLanguage);
for (const button of document.querySelectorAll('input[name="quality"]')) button.addEventListener('change', updateQuality);
$('#history-search').addEventListener('input', renderHistory);
$('#new-prompt').addEventListener('click', newPrompt);
$('#menu-toggle').addEventListener('click', toggleSidebar);
$('#theme-toggle').addEventListener('click', toggleTheme);
window.addEventListener('resize', () => setSidebar(isMobile() && $('#sidebar').classList.contains('open')));
$('#sidebar-scrim').addEventListener('click', () => setSidebar(false));
$('#setup-help').addEventListener('click', () => openHelp());
$('#privacy-help').addEventListener('click', () => openHelp(true));
$('#close-dialog').addEventListener('click', () => $('#help-dialog').close());
$('#dialog-done').addEventListener('click', () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', (event) => {
  if (event.target !== $('#help-dialog')) return;
  const box = $('#help-dialog').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('#help-dialog').close();
});
$('#cancel-button').addEventListener('click', () => { if (!controller) return; $('#cancel-button').disabled = true; announce('Cancelling…'); controller.abort(); });
$('#auth-login').addEventListener('click', () => signIn('browser'));
$('#auth-device').addEventListener('click', () => signIn('device'));
$('#auth-logout').addEventListener('click', signOut);
$('#auth-check').addEventListener('click', () => { loadAuth(); loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: true }); });
$('#copy-button').addEventListener('click', async () => {
  if (!currentResult) return;
  try {
    await navigator.clipboard.writeText(currentResult.prompt);
    $('#copy-label').textContent = 'Copied!';
    announce('Prompt copied to your clipboard.');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('#copy-label').textContent = 'Copy prompt'; }, 1800);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($('#prompt-output'));
    selection.removeAllRanges();
    selection.addRange(range);
    $('#prompt-output').focus();
    announce('Clipboard access is unavailable. The prompt is selected. Press Command+C or Control+C to copy it.');
    $('#copy-label').textContent = 'Press ⌘/Ctrl+C';
  }
});
$('#export-button').addEventListener('click', () => {
  if (!currentResult) return;
  downloadFile(`${currentResult.prompt}\n`, 'text/markdown;charset=utf-8', `ste-prompt-${exportDate()}.md`);
  announce('Prompt exported as Markdown.');
});
$('#report-button').addEventListener('click', () => {
  if (!currentResult?.verification) return;
  const { input, provider, model, effort, language, quality, detail, task, options, terminology, prompt, reportedModels, verification, lint } = currentResult;
  const report = { application: 'Promptboard', request: { input, provider, model, effort, language, quality, detail, task, options, terminology }, prompt, reportedModels, verification, lint };
  downloadFile(`${JSON.stringify(report, null, 2)}\n`, 'application/json;charset=utf-8', `ste-check-report-${exportDate()}.json`);
  announce('Check report exported as JSON. It includes your request and the prompt.');
});
function exportDate() { return new Date(currentResult.createdAt || Date.now()).toISOString().slice(0, 10); }
function downloadFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('keydown', (event) => {
  const isEditing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
  if (event.key.toLowerCase() === 'n' && !isEditing && !event.metaKey && !event.ctrlKey && !event.altKey && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    newPrompt();
  }
  if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) { setSidebar(false); $('#menu-toggle').focus(); }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && isEditing && $('#prompt-form').contains(event.target) && !running && !$('#generate-button').disabled) {
    event.preventDefault();
    $('#prompt-form').requestSubmit();
  }
});

renderTheme();
syncSidebarToggle();
renderHistory();
updateCount();
updateQuality();
// ---- Autopilot: queued To Do cards go through their routes one at a time ----

const ROUTE_ORDER = ['planning', 'executing', 'code_review', 'testing', 'merge'];
const ROUTE_SHORT = { planning: 'Plan', executing: 'Execute', code_review: 'Review', testing: 'Test', merge: 'Merge' };
let autopilotDraft = null;

async function autopilotCall(action, extra = {}) {
  const project = currentProject();
  if (!project) return false;
  try { await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/autopilot`, { action, ...extra }); return true; }
  catch (error) { showBoardError(error); return false; }
}

function renderAutopilotBar(project) {
  const bar = $('#autopilot-bar');
  const ap = project?.autopilot;
  $('#autopilot-open').disabled = !project;
  // Autopilot works on the server; while it runs, keep this page current.
  clearTimeout(renderAutopilotBar.timer);
  if (board?.projects.some(item => item.autopilot?.status === 'running')) renderAutopilotBar.timer = setTimeout(() => { if (!document.hidden && location.hash === '#/kanban') loadBoard().catch(() => {}); else renderAutopilotBar(currentProject()); }, 3000);
  if (!ap || ap.status === 'off') { bar.hidden = true; return; }
  const task = ap.current && project.tasks.find(item => item.id === ap.current.taskId);
  const left = ap.queue.filter(id => !(ap.done || []).includes(id) && id !== ap.current?.taskId && project.tasks.some(item => item.id === id && item.column === 'todo')).length;
  // A startup question or a permission prompt holds Autopilot until you answer it in the terminal.
  const run = task && board.runs.filter(item => item.taskId === task.id && RUN_LIVE.includes(item.status)).at(-1);
  const needsYou = run && ((run.status === 'waiting_for_input' && !run.turnComplete) || run.lifecycle === 'no-events-yet');
  const text = ap.status === 'running' ? (task ? `Autopilot is working on “${task.title}” · ${columnTitle(ap.current.stage || 'todo')} · ${left} more queued${needsYou ? ' · the agent is waiting for your answer in the terminal' : ''}` : 'Autopilot is choosing the next card…')
    : ap.status === 'paused' ? `Autopilot paused: ${ap.reason}`
    : 'Autopilot finished: every queued card has been through its route.';
  const buttons = [];
  if (needsYou) buttons.push(detailButton('Open terminal', () => window.PromptboardDock?.open(run.id), 'danger'));
  if (ap.status === 'running') buttons.push(detailButton('Pause', () => autopilotCall('pause')));
  if (ap.status === 'paused') buttons.push(detailButton('Resume', () => autopilotCall('resume'), 'danger'));
  if (ap.current && ap.status !== 'finished') buttons.push(detailButton('Skip card', () => autopilotCall('skip')));
  buttons.push(detailButton(ap.status === 'finished' ? 'Close' : 'Stop', () => autopilotCall('stop')));
  buttons.push(detailButton('Settings', openAutopilot));
  bar.className = `autopilot-bar ${ap.status}${needsYou ? ' needs-you' : ''}`;
  bar.replaceChildren(paragraph(text), detailActions(...buttons));
  bar.hidden = false;
}

/** `first`: cards to put first and include, in this order (for example the cards just made by a split). */
function openAutopilot({ first = [] } = {}) {
  const project = currentProject();
  if (!project) return;
  const saved = project.autopilot;
  const todo = project.tasks.filter(task => task.column === 'todo');
  // Saved order first, then the rest of To Do in board order. New cards are included the first time.
  const lead = first.filter(id => todo.some(task => task.id === id));
  const queued = (saved?.queue || []).filter(id => todo.some(task => task.id === id) && !lead.includes(id));
  const order = [...lead, ...queued, ...todo.map(task => task.id).filter(id => !queued.includes(id) && !lead.includes(id))];
  autopilotDraft = {
    route: saved?.route || [...ROUTE_ORDER], finish: saved?.finish || 'merge', maxRework: saved?.maxRework ?? 2,
    order, included: new Set(lead.length ? lead : saved ? queued : order), routes: { ...(saved?.routes || {}) },
  };
  $('#autopilot-project').textContent = `${project.name} · AUTOPILOT`;
  $('#autopilot-consent').checked = false;
  $('#autopilot-error').hidden = true;
  renderAutopilotDialog();
  if (!$('#autopilot-dialog').open) $('#autopilot-dialog').showModal();
}

function routeChips(route, onChange, { compact = false, disabled = false } = {}) {
  const box = document.createElement('div');
  box.className = `route-chips${compact ? ' compact' : ''}`;
  for (const stage of ROUTE_ORDER) {
    const label = document.createElement('label');
    label.className = 'route-chip';
    label.dataset.stage = stage;
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = route.includes(stage); input.value = stage;
    input.disabled = disabled || stage === 'executing';
    input.setAttribute('aria-label', columnTitle(stage));
    input.addEventListener('change', () => onChange(ROUTE_ORDER.filter(item => item === stage ? input.checked : route.includes(item))));
    const span = document.createElement('span'); span.textContent = compact ? ROUTE_SHORT[stage] : columnTitle(stage);
    label.append(input, span);
    box.append(label);
  }
  return box;
}

function renderAutopilotDialog() {
  const project = currentProject();
  const draft = autopilotDraft;
  if (!project || !draft) return;
  const running = project.autopilot?.status === 'running';
  $('#autopilot-route').replaceWith(Object.assign(routeChips(draft.route, route => { draft.route = route; renderAutopilotDialog(); }, { disabled: running }), { id: 'autopilot-route' }));
  $('#autopilot-finish').value = draft.finish;
  $('#autopilot-finish').disabled = running || !draft.route.includes('merge');
  $('#autopilot-rework').value = String(draft.maxRework);
  $('#autopilot-rework').disabled = running;
  const tasks = new Map(project.tasks.map(task => [task.id, task]));
  const included = draft.order.filter(id => draft.included.has(id));
  $('#autopilot-queue-note').textContent = draft.order.length ? `${included.length} of ${draft.order.length} To Do cards · top runs first` : '';
  const list = $('#autopilot-queue');
  list.replaceChildren(...draft.order.map((id, index) => {
    const task = tasks.get(id);
    const item = document.createElement('li');
    item.className = `autopilot-item${draft.included.has(id) ? '' : ' excluded'}`;
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = draft.included.has(id); check.disabled = running;
    check.setAttribute('aria-label', `Include “${task.title}” in Autopilot`);
    check.addEventListener('change', () => { check.checked ? draft.included.add(id) : draft.included.delete(id); renderAutopilotDialog(); });
    const name = document.createElement('span'); name.className = 'autopilot-title'; name.textContent = task.title;
    const move = offset => () => { const to = index + offset; if (to < 0 || to >= draft.order.length) return; [draft.order[index], draft.order[to]] = [draft.order[to], draft.order[index]]; renderAutopilotDialog(); list.children[to]?.querySelector(offset < 0 ? '.autopilot-up' : '.autopilot-down')?.focus(); };
    const up = detailButton('↑', move(-1), 'autopilot-up'); up.setAttribute('aria-label', `Move “${task.title}” up`); up.disabled = running || index === 0;
    const down = detailButton('↓', move(1), 'autopilot-down'); down.setAttribute('aria-label', `Move “${task.title}” down`); down.disabled = running || index === draft.order.length - 1;
    const own = draft.routes[id];
    const chips = routeChips(own || draft.route, route => { if (JSON.stringify(route) === JSON.stringify(draft.route)) delete draft.routes[id]; else draft.routes[id] = route; renderAutopilotDialog(); }, { compact: true, disabled: running || !draft.included.has(id) });
    const custom = document.createElement('small'); custom.className = 'autopilot-custom'; custom.textContent = own ? 'Own route' : 'Default route';
    const head = document.createElement('div'); head.className = 'autopilot-head';
    head.append(check, name, up, down);
    item.append(head, chips, custom);
    return item;
  }));
  if (!draft.order.length) list.replaceChildren(Object.assign(document.createElement('li'), { className: 'note', textContent: 'No cards in To Do. Add the tasks first (one card per subtask), then come back.' }));
  $('#autopilot-save').disabled = running;
  $('#autopilot-start').disabled = running || !included.length;
  $('#autopilot-start').firstChild.textContent = project.autopilot?.status === 'paused' ? 'Save and restart ' : 'Save and start ';
  const log = (project.autopilot?.log || []).slice(-30).reverse();
  $('#autopilot-log-box').hidden = !log.length;
  $('#autopilot-log').replaceChildren(...log.map(entry => { const li = document.createElement('li'); li.textContent = `${new Date(entry.at).toLocaleTimeString()} · ${entry.text}`; return li; }));
}

async function saveAutopilot(start) {
  const project = currentProject();
  const draft = autopilotDraft;
  if (!project || !draft) return false;
  const showError = message => { $('#autopilot-error').textContent = message; $('#autopilot-error').hidden = false; };
  if (start && !$('#autopilot-consent').checked) { showError('Confirm that you understand what Autopilot does before you start it.'); $('#autopilot-consent').focus(); return false; }
  const queue = draft.order.filter(id => draft.included.has(id));
  const routes = Object.fromEntries(Object.entries(draft.routes).filter(([id]) => queue.includes(id)));
  try {
    await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/autopilot`, { route: draft.route, finish: draft.route.includes('merge') ? draft.finish : 'merge', maxRework: draft.maxRework, queue, routes, expectedRevision: project.revision });
    if (start) await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/autopilot`, { action: 'start', confirm: true });
  } catch (error) { showError(error.message); return false; }
  $('#autopilot-dialog').close();
  announce(start ? `Autopilot started for “${project.name}” with ${plural(queue.length, 'card')}.` : 'Autopilot settings saved.');
  return true;
}

$('#autopilot-open').addEventListener('click', openAutopilot);

// ---- Column Manager ----
// Built-in stages keep their order and rules (rename, recolour; Planning can be hidden). Custom columns
// go anywhere between To Do and Done and are attached to the built-in stage on their left.
const COLUMN_COLOR_NAMES = { gray: 'Gray', red: 'Red', orange: 'Orange', amber: 'Amber', green: 'Green', teal: 'Teal', blue: 'Blue', violet: 'Violet', pink: 'Pink' };
const BUILTIN_DEFAULT_COLORS = { todo: 'gray', planning: 'violet', executing: 'blue', code_review: 'amber', testing: 'teal', merge: 'orange', done: 'green' };
const columnsDraft = { list: [], selected: null, project: null, revision: null, pipeline: false, profiles: [] };
const builtinTitle = id => board?.columns?.find(column => column.id === id)?.title || id;
function openColumns() {
  const project = currentProject();
  if (!project) return;
  const layout = project.columnLayout?.length ? project.columnLayout : (board?.columns || []).map(column => ({ id: column.id }));
  columnsDraft.project = project.id;
  columnsDraft.revision = project.revision;
  columnsDraft.pipeline = project.workflowMode === 'pipeline';
  columnsDraft.profiles = JSON.parse(JSON.stringify(project.pipeline?.profiles || []));
  columnsDraft.list = JSON.parse(JSON.stringify(columnsDraft.pipeline ? project.pipeline.columns : layout));
  columnsDraft.selected = columnsDraft.list.find(entry => entry.custom)?.id || 'executing';
  $('#columns-project').textContent = `${project.name} · COLUMNS`;
  $('#columns-error').hidden = true;
  renderColumns();
  $('#columns-dialog').showModal();
}
const draftAnchor = entry => { let anchor = 'todo'; for (const item of columnsDraft.list) { if (item === entry) return anchor; if (!item.custom && !item.hidden) anchor = item.id; } return anchor; };
function renderColumns() {
  $('#columns-use-pipeline').hidden = columnsDraft.pipeline;
  $('#columns-mode-note').textContent = columnsDraft.pipeline
    ? 'Columns control the agent’s session. Moves send no stage instructions. Pause agents before changing settings. Plan exit automation is being added; move approved plans to Executing manually for now.'
    : 'This board uses the original stage rules. Switching removes automatic stage instructions and keeps the saved tasks, files, and run history. Save to confirm the switch.';
  if (columnsDraft.pipeline) return renderPipelineColumns();
  const list = columnsDraft.list;
  $('#columns-list').replaceChildren(...list.map((entry, index) => {
    const row = document.createElement('li'); row.className = 'columns-row';
    const button = document.createElement('button'); button.type = 'button';
    button.className = `columns-item${entry.hidden ? ' hidden-column' : ''}`;
    if (entry.id === columnsDraft.selected) button.setAttribute('aria-current', 'true');
    const dot = document.createElement('i'); dot.className = `columns-dot dot-${entry.color || BUILTIN_DEFAULT_COLORS[entry.id] || 'gray'}`; dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.textContent = `${entry.title || builtinTitle(entry.id)}${entry.hidden ? ' (hidden)' : ''}`;
    button.append(dot, name);
    if (!entry.custom) { const lock = document.createElement('small'); lock.className = 'columns-lock'; lock.textContent = 'fixed'; button.append(lock); }
    button.addEventListener('click', () => { columnsDraft.selected = entry.id; renderColumns(); });
    row.append(button);
    if (entry.custom) {
      const move = (step, label) => { const b = detailButton(step < 0 ? '↑' : '↓', () => { list.splice(index, 1); list.splice(index + step, 0, entry); renderColumns(); $(`#columns-list [data-move="${entry.id}${step}"]`)?.focus(); }, 'icon-button'); b.dataset.move = `${entry.id}${step}`; b.setAttribute('aria-label', `${label}: ${entry.title}`); b.disabled = step < 0 ? index <= 1 : index >= list.length - 2; return b; };
      row.append(move(-1, 'Move left'), move(1, 'Move right'));
    }
    return row;
  }));
  renderColumnEditor();
}
function renderColumnEditor() {
  const entry = columnsDraft.list.find(item => item.id === columnsDraft.selected);
  const editor = $('#columns-editor');
  $('#columns-remove').hidden = !entry?.custom;
  if (!entry) { editor.replaceChildren(); return; }
  const group = (legendText, ...children) => { const box = document.createElement('fieldset'); box.className = 'settings-group'; const legend = document.createElement('legend'); legend.textContent = legendText; box.append(legend, ...children); return box; };
  const field = (labelText, control) => { const label = document.createElement('label'); label.className = 'field-label'; label.append(labelText, control); return label; };
  const name = document.createElement('input'); name.type = 'text'; name.maxLength = 40; name.id = 'column-name'; name.value = entry.title || builtinTitle(entry.id);
  name.addEventListener('input', () => { entry.title = name.value; const current = $('#columns-list [aria-current="true"] span'); if (current) current.textContent = name.value; });
  const swatches = document.createElement('div'); swatches.className = 'color-swatches'; swatches.setAttribute('role', 'radiogroup'); swatches.setAttribute('aria-label', 'Colour');
  for (const [color, label] of Object.entries(COLUMN_COLOR_NAMES)) {
    const option = document.createElement('label'); option.title = label;
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'column-color'; input.value = color; input.setAttribute('aria-label', label);
    input.checked = (entry.color || BUILTIN_DEFAULT_COLORS[entry.id] || 'gray') === color;
    input.addEventListener('change', () => { entry.color = color; renderColumns(); });
    const dot = document.createElement('span'); dot.className = `dot-${color}`;
    option.append(input, dot); swatches.append(option);
  }
  const general = [field('Name', name)];
  if (entry.custom) {
    const description = document.createElement('textarea'); description.maxLength = 200; description.id = 'column-description'; description.placeholder = 'What is this column for?'; description.value = entry.description || '';
    description.addEventListener('input', () => { entry.description = description.value; });
    general.push(field('Description', description));
  }
  general.push(field('Colour', swatches));
  const nodes = [group('General', ...general)];
  if (!entry.custom) {
    const notes = [paragraph(`${builtinTitle(entry.id)} is a built-in stage. Its place and rules stay fixed, because review, tests, and merges depend on them. You can rename and recolour it.`, 'note')];
    if (entry.id === 'planning') {
      const show = document.createElement('label'); show.className = 'check-row';
      const box = document.createElement('input'); box.type = 'checkbox'; box.id = 'column-show'; box.checked = !entry.hidden;
      box.addEventListener('change', () => { entry.hidden = !box.checked || undefined; renderColumns(); });
      show.append(box, ' Show this column (cards can go from To Do straight to Executing either way)');
      notes.push(show);
    }
    nodes.push(group('Stage', ...notes));
  } else {
    entry.agent ||= { enabled: false };
    const enabled = document.createElement('label'); enabled.className = 'check-row';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = 'column-agent'; toggle.checked = entry.agent.enabled;
    enabled.append(toggle, ' Start an agent here');
    const detail = document.createElement('div'); detail.className = 'columns-agent'; detail.hidden = !entry.agent.enabled;
    const policy = document.createElement('div'); policy.className = 'segmented';
    for (const [value, label] of [['start', 'Start automatically'], ['manual', 'From the card only']]) {
      const option = document.createElement('label'); const input = document.createElement('input'); input.type = 'radio'; input.name = 'column-policy'; input.value = value; input.checked = (entry.agent.policy === 'manual' ? 'manual' : 'start') === value;
      input.addEventListener('change', () => { entry.agent.policy = value; });
      const span = document.createElement('span'); span.textContent = label; option.append(input, span); policy.append(option);
    }
    const instructions = document.createElement('textarea'); instructions.maxLength = 4000; instructions.id = 'column-instructions'; instructions.placeholder = 'What should the agent do in this column?'; instructions.value = entry.agent.instructions || '';
    instructions.addEventListener('input', () => { entry.agent.instructions = instructions.value; });
    const fields = agentFields(entry.agent, { inherit: 'Use project agent', inheritedProvider: currentProject()?.agentDefaults?.provider || board?.settings?.defaultAgent?.provider || 'claude' });
    const saveAgent = () => {
      for (const key of ['provider', 'model', 'effort', 'permissionMode']) delete entry.agent[key];
      Object.assign(entry.agent, readAgentFields(fields) || {});
    };
    fields.addEventListener('change', saveAgent);
    fields.addEventListener('input', saveAgent);
    detail.append(policy, fields, field('Instructions for the agent', instructions), paragraph('The agent works in the card’s own worktree and never commits. Changed code still goes through Code Review and Testing before it can merge.', 'note'));
    toggle.addEventListener('change', () => { entry.agent.enabled = toggle.checked; entry.agent.policy ||= 'start'; detail.hidden = !toggle.checked; });
    const anchor = draftAnchor(entry);
    nodes.push(group('Agent', enabled, detail), group('Moves', paragraph(`Cards reach this column from ${builtinTitle(anchor)} and leave it along ${builtinTitle(anchor)}’s moves (or to another custom column next to it). Move the column to attach it to another stage.`, 'note')));
  }
  const existing = projectColumnsOf(currentProject()).some(column => column.id === entry.id);
  nodes.push(group('Base resources', existing ? basePicker({ target: { scope: 'column', projectId: currentProject().id, columnId: entry.id }, inactive: entry.custom ? !entry.agent?.enabled : ['todo', 'done'].includes(entry.id) }) : paragraph('Save this new column before assigning Base resources. Assignments use its stable column ID.', 'note')));
  editor.replaceChildren(...nodes);
}
function renderPipelineColumns() {
  const list = columnsDraft.list;
  $('#columns-list').replaceChildren(...list.map((entry, index) => {
    const row = document.createElement('li'); row.className = 'columns-row';
    const button = detailButton(entry.name, () => { columnsDraft.selected = entry.id; renderColumns(); }, 'columns-item');
    if (entry.id === columnsDraft.selected) button.setAttribute('aria-current', 'true');
    row.append(button);
    if (entry.role === 'active') for (const step of [-1, 1]) {
      const move = detailButton(step < 0 ? '↑' : '↓', () => {
        list.splice(index, 1); list.splice(index + step, 0, entry); renderColumns();
        $(`#columns-list [data-move="${entry.id}${step}"]`)?.focus();
      }, 'icon-button');
      move.dataset.move = `${entry.id}${step}`; move.setAttribute('aria-label', `${step < 0 ? 'Move left' : 'Move right'}: ${entry.name}`);
      move.disabled = step < 0 ? index <= 1 : index >= list.length - 2; row.append(move);
    }
    return row;
  }));
  const entry = list.find(column => column.id === columnsDraft.selected) || list[0];
  $('#columns-remove').hidden = entry.role !== 'active';
  const editor = $('#columns-editor');
  const field = (title, input) => { const label = document.createElement('label'); label.className = 'field-label'; label.append(title, input); return label; };
  const name = document.createElement('input'); name.id = 'column-name'; name.maxLength = 80; name.value = entry.name;
  name.addEventListener('input', () => { entry.name = name.value; const item = $('#columns-list [aria-current="true"]'); if (item) item.textContent = name.value; });
  const description = document.createElement('textarea'); description.id = 'column-description'; description.maxLength = 4000; description.value = entry.description;
  description.addEventListener('input', () => { entry.description = description.value; });
  const color = document.createElement('select'); color.setAttribute('aria-label', 'Column colour');
  color.append(...Object.entries(COLUMN_COLOR_NAMES).map(([value, label]) => option(value, label))); color.value = entry.color;
  color.addEventListener('change', () => { entry.color = color.value; });
  const nodes = [field('Name', name), field('Description', description), field('Colour', color)];
  if (entry.role === 'active') {
    const automatic = document.createElement('input'); automatic.type = 'checkbox'; automatic.checked = entry.strategy.autoSpawn !== false; automatic.id = 'column-auto-spawn';
    automatic.addEventListener('change', () => { entry.strategy.autoSpawn = automatic.checked; });
    const label = document.createElement('label'); label.className = 'check-row'; label.append(automatic, ' Start or resume an agent when a card arrives'); nodes.push(label);
    const provider = document.createElement('select'); provider.setAttribute('aria-label', 'Column agent');
    provider.append(option('', 'Use project agent'), ...['claude', 'codex', 'gemini'].map(id => option(id, board?.execution?.providers?.[id]?.name || id)));
    provider.value = entry.strategy.agentOverride || '';
    provider.addEventListener('change', () => { entry.strategy.agentOverride = provider.value || null; }); nodes.push(field('Agent', provider));
    for (const [key, title, max] of [['modelOverride', 'Model ID (empty uses the agent default)', 100], ['effortOverride', 'Effort (empty uses the agent default)', 20]]) {
      const input = key === 'effortOverride' ? document.createElement('select') : document.createElement('input'); input.maxLength = max;
      if (key === 'effortOverride') input.append(option('', 'Use agent default'), ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => option(value, value)));
      input.value = entry.strategy[key] || ''; input.addEventListener('change', () => { entry.strategy[key] = input.value || null; }); nodes.push(field(title, input));
    }
    const permissions = document.createElement('select'); permissions.setAttribute('aria-label', 'Column permissions');
    permissions.append(...[['', 'Use agent default'], ['plan', 'Plan mode'], ['default', 'Ask for permission'], ['acceptEdits', 'Claude: accept file edits'], ['workspace-write', 'Codex: write in workspace'], ['auto_edit', 'Gemini: accept file edits']].map(([value, label]) => option(value, label)));
    permissions.value = entry.strategy.permissionMode || ''; permissions.addEventListener('change', () => { entry.strategy.permissionMode = permissions.value || null; }); nodes.push(field('Permissions', permissions));
    nodes.push(paragraph('A running conversation continues silently between compatible columns. Pause it first when changing its agent, permissions, or Base resources.', 'note'));
  } else nodes.push(paragraph(entry.role === 'todo' ? 'The holding role never starts agents. Returning a card stops its agent and resets the current session; files and historical output are kept.'
    : 'The completion role pauses the agent and archives its task, preserving the conversation and worktree for restoration.', 'note'));
  if (projectColumnsOf().some(column => column.id === entry.id)) nodes.push(basePicker({ target: { scope: 'column', projectId: currentProject().id, columnId: entry.id }, inactive: entry.role !== 'active' }));
  editor.replaceChildren(...nodes);
}

$('#columns-use-pipeline').addEventListener('click', () => {
  columnsDraft.pipeline = true;
  columnsDraft.list = columnsDraft.list.filter(entry => !entry.hidden).map(entry => ({ id: entry.id, name: entry.title || builtinTitle(entry.id),
    role: entry.id === 'todo' ? 'todo' : entry.id === 'done' ? 'done' : 'active', color: entry.color || BUILTIN_DEFAULT_COLORS[entry.id] || 'gray', description: entry.description || '',
    strategy: entry.id === 'planning' ? { permissionMode: 'plan', planExitTargetId: 'executing' } : entry.custom ? { autoSpawn: entry.agent?.enabled === true && entry.agent?.policy !== 'manual' } : {},
    automations: { onEnter: [], onExit: [] } }));
  renderColumns();
});

function addColumn() {
  const list = columnsDraft.list;
  const at = Math.min(Math.max(list.findIndex(entry => entry.id === columnsDraft.selected) + 1, 1), list.length - 1);
  const taken = new Set(list.map(entry => (entry.name || entry.title || builtinTitle(entry.id)).toLowerCase()));
  let title = 'New column';
  for (let n = 2; taken.has(title.toLowerCase()); n++) title = `New column ${n}`;
  const id = `c_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/g, '').slice(0, 12).padEnd(8, '0')}`;
  list.splice(at, 0, columnsDraft.pipeline ? { id, name: title, role: 'active', color: 'blue', description: '', strategy: { autoSpawn: false }, automations: { onEnter: [], onExit: [] } }
    : { id, custom: true, title, color: 'blue', description: '', agent: { enabled: false } });
  columnsDraft.selected = id;
  renderColumns();
  $('#column-name')?.select();
}
async function saveColumns(event) {
  event.preventDefault();
  const project = board?.projects.find(item => item.id === columnsDraft.project);
  if (!project) return;
  const columns = columnsDraft.list.map(entry => entry.custom ? entry : { id: entry.id, ...(entry.title && entry.title !== builtinTitle(entry.id) ? { title: entry.title } : {}), ...(entry.color && entry.color !== BUILTIN_DEFAULT_COLORS[entry.id] ? { color: entry.color } : {}), ...(entry.hidden ? { hidden: true } : {}) });
  try { await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/${columnsDraft.pipeline ? 'pipeline' : 'columns'}`, columnsDraft.pipeline
    ? { pipeline: { version: 1, columns: columnsDraft.list, profiles: columnsDraft.profiles }, expectedRevision: columnsDraft.revision, confirm: true }
    : { columns, expectedRevision: project.revision }); }
  catch (error) { $('#columns-error').textContent = error.message; $('#columns-error').hidden = false; return; }
  $('#columns-dialog').close();
  announce('Columns saved.');
}
$('#columns-open').addEventListener('click', openColumns);
$('#columns-add').addEventListener('click', addColumn);
$('#columns-form').addEventListener('submit', saveColumns);
$('#columns-remove').addEventListener('click', () => {
  const index = columnsDraft.list.findIndex(entry => entry.id === columnsDraft.selected);
  if (index < 0 || (columnsDraft.pipeline ? columnsDraft.list[index].role !== 'active' : !columnsDraft.list[index].custom)) return;
  const [removed] = columnsDraft.list.splice(index, 1);
  if (columnsDraft.pipeline) {
    for (const column of columnsDraft.list) if (column.strategy.planExitTargetId === removed.id) column.strategy.planExitTargetId = null;
    for (const profile of columnsDraft.profiles) {
      delete profile.columns[removed.id];
      for (const strategy of Object.values(profile.columns)) if (strategy.planExitTargetId === removed.id) strategy.planExitTargetId = null;
    }
  }
  columnsDraft.selected = columnsDraft.list[Math.max(1, index - 1)].id;
  renderColumns();
});
for (const id of ['#columns-cancel', '#columns-close']) $(id).addEventListener('click', () => $('#columns-dialog').close());

// ---- Timeline ----
// One project's history from the server: recorded moves, runs, evidence, completions, Git commits,
// and the user's notes. The page never adds events of its own.
const PROJECT_VIEW_KEY = 'promptboard.project-view';
const timeline = { projectId: null, events: [], loadedAt: 0, loading: null, editing: null, scrolledFor: null };
const EVENT_LABELS = { restart: 'Started over', created: 'Created', moved: 'Moved', run: 'Agent run', review: 'Review', tests: 'Tests', pull_request: 'Pull request', completed: 'Completed', commit: 'Commit', note: 'Note' };
function projectView() { try { return localStorage.getItem(PROJECT_VIEW_KEY) === 'timeline' ? 'timeline' : 'board'; } catch { return 'board'; } }
function setProjectView(view) { savePref(PROJECT_VIEW_KEY, view); timeline.loadedAt = 0; renderBoard(); if (view === 'timeline') $('#timeline-track').focus({ preventScroll: true }); }
$('#view-board').addEventListener('click', () => setProjectView('board'));
$('#view-timeline').addEventListener('click', () => setProjectView('timeline'));
$('#timeline-filter').addEventListener('change', () => renderTimeline(currentProject()));

/** Reload at most every 2 seconds while the timeline is shown; board refreshes call this often. */
function refreshTimeline(project) {
  if (timeline.projectId !== project.id) Object.assign(timeline, { projectId: project.id, events: [], loadedAt: 0, editing: null });
  renderTimeline(project);
  if (timeline.loading || Date.now() - timeline.loadedAt < 2000) return;
  timeline.loading = (async () => {
    try {
      const { response, data } = await api(`/api/projects/${encodeURIComponent(project.id)}/timeline`, { timeoutMs: 30000 });
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The timeline could not be loaded.');
      if (timeline.projectId === project.id) { timeline.events = Array.isArray(data.events) ? data.events : []; timeline.error = ''; }
    } catch (error) { timeline.error = error.message; }
    finally { timeline.loadedAt = Date.now(); timeline.loading = null; if (currentProject()?.id === project.id) renderTimeline(project); }
  })();
}

const dayKey = at => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const duration = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };

function timelineEvent(event, order, project) {
  const item = document.createElement('li');
  item.className = 'timeline-event';
  item.dataset.kind = event.kind; item.dataset.status = event.status || '';
  item.dataset.id = event.id;
  const head = document.createElement('div'); head.className = 'timeline-head';
  const kind = document.createElement('span'); kind.className = 'timeline-kind'; kind.textContent = EVENT_LABELS[event.kind] || event.kind;
  if (order) { const badge = document.createElement('span'); badge.className = 'timeline-order'; badge.textContent = `#${order}`; badge.title = `Completed work #${order} in this project`; kind.append(badge); }
  head.append(kind, clock(event.at));
  item.append(head);
  const exists = event.taskId && project.tasks.some(task => task.id === event.taskId);
  if (event.taskTitle) {
    const task = exists ? detailButton(event.taskTitle, () => openTaskDetails(event.taskId), 'timeline-task') : Object.assign(document.createElement('span'), { className: 'timeline-task', textContent: event.taskTitle });
    if (exists) task.setAttribute('aria-label', `Open task: ${event.taskTitle}`);
    item.append(task);
  }
  const title = event.kind === 'moved' ? `Moved to ${columnTitle(event.stage)}` : event.kind === 'run' ? `${columnTitle(event.stage)} · ${event.title}` : event.title;
  item.append(paragraph(title, 'timeline-title'));
  const meta = [];
  if (event.kind === 'moved' && event.from) meta.push(`From ${columnTitle(event.from)}`);
  else if (event.detail) meta.push(event.detail);
  if (event.status) meta.push(event.kind === 'run' && event.endAt ? `${event.status.replaceAll('_', ' ')} after ${duration(event.endAt - event.at)}` : event.status.replaceAll('_', ' '));
  if (event.agent) meta.push(`${providerName(event.agent.provider)} · ${event.agent.model || 'CLI default model'}${event.agent.effort ? ` · ${event.agent.effort}` : ''}`);
  for (const line of meta) { const p = paragraph(line, 'timeline-meta'); p.title = line; item.append(p); }
  if (event.commit || event.pr) {
    const refs = document.createElement('p'); refs.className = 'timeline-meta';
    if (event.commit) { const code = document.createElement('code'); code.textContent = event.commit.slice(0, 10); code.title = event.commit; refs.append('Commit ', code); }
    if (event.pr?.url) { if (event.commit) refs.append(' · '); refs.append(externalLink(event.pr.url, `PR ${event.pr.number ? `#${event.pr.number}` : ''} · ${String(event.pr.state || '').toUpperCase()}`)); }
    item.append(refs);
  }
  const actions = [];
  if (event.kind === 'run' && event.runId) actions.push(detailButton('Output', () => window.PromptboardDock?.open(event.runId)));
  if (event.editable) {
    actions.push(detailButton('Edit', () => openNoteForm(event)));
    const remove = detailButton('Remove', () => {
      const box = item.querySelector('.timeline-actions');
      const yes = detailButton('Remove note', () => deleteNote(event.noteId)), no = detailButton('Keep', () => renderTimeline(currentProject()));
      box.replaceChildren(yes, no); yes.focus();
    });
    actions.push(remove);
  }
  if (actions.length) { const row = document.createElement('div'); row.className = 'timeline-actions'; row.append(...actions); item.append(row); }
  return item;
}

function renderTimeline(project) {
  const filter = $('#timeline-filter').value;
  const all = timeline.projectId === project.id ? timeline.events : [];
  const completed = all.filter(event => event.kind === 'completed');
  const order = new Map(completed.map((event, index) => [event.id, index + 1]));
  const shown = all.filter(event => filter === 'all' || (filter === 'completed' ? event.kind === 'completed' : event.kind !== 'moved'));
  const runs = all.filter(event => event.kind === 'run').length, commits = all.filter(event => event.kind === 'commit').length;
  $('#timeline-summary').textContent = all.length
    ? `${plural(project.tasks.length, 'task')} · ${completed.length} completed · ${plural(runs, 'agent run')} · ${plural(commits, 'commit')} · ${new Date(all[0].at).toLocaleDateString()} – ${new Date(all.at(-1).at).toLocaleDateString()}`
    : '';
  $('#timeline-empty').hidden = shown.length > 0 && !timeline.error;
  $('#timeline-empty').textContent = timeline.error || (timeline.loadedAt ? (all.length ? 'No events match this filter.' : 'No history yet. Events appear when cards move, agents run, and work is committed or merged.') : 'Loading the timeline…');
  $('#timeline-empty').classList.toggle('inline-error', Boolean(timeline.error));
  const days = [];
  for (const event of shown) { if (days.at(-1)?.key !== dayKey(event.at)) days.push({ key: dayKey(event.at), at: event.at, events: [] }); days.at(-1).events.push(event); }
  const track = $('#timeline-track');
  const keepScroll = timeline.scrolledFor === project.id ? track.scrollLeft : null;
  track.replaceChildren(...days.map(day => {
    const column = document.createElement('section'); column.className = 'timeline-day';
    const date = document.createElement('h3'); date.className = 'timeline-date';
    date.append(new Date(day.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
    const count = document.createElement('small'); count.textContent = plural(day.events.length, 'event'); date.append(count);
    const list = document.createElement('ol'); list.className = 'timeline-events';
    list.append(...day.events.map(event => timelineEvent(event, order.get(event.id), project)));
    column.append(date, list);
    return column;
  }));
  // Open at the latest work; later refreshes keep the user's scroll position.
  if (keepScroll === null) { if (days.length) { track.scrollLeft = track.scrollWidth; timeline.scrolledFor = project.id; } }
  else track.scrollLeft = keepScroll;
}

const localInput = at => new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function openNoteForm(event = null) {
  const project = currentProject();
  if (!project) return;
  timeline.editing = event?.noteId || null;
  $('#note-title').value = event?.title || '';
  $('#note-text').value = event?.detail || '';
  $('#note-at').value = localInput(event?.at || Date.now());
  $('#note-task').replaceChildren(option('', 'No task'), ...project.tasks.map(task => option(task.id, task.title)));
  $('#note-task').value = event?.taskId || '';
  $('#note-save').textContent = event ? 'Save changes' : 'Save note';
  $('#note-error').hidden = true;
  $('#timeline-note-form').hidden = false;
  $('#note-title').focus();
}
async function saveNote(event) {
  event.preventDefault();
  const project = currentProject();
  const at = new Date($('#note-at').value).getTime();
  const body = { title: $('#note-title').value.trim(), text: $('#note-text').value, at, taskId: $('#note-task').value || null };
  const showError = message => { $('#note-error').textContent = message; $('#note-error').hidden = false; };
  if (!body.title) { showError('Enter a note title.'); $('#note-title').focus(); return; }
  if (!Number.isFinite(at)) { showError('Choose a date and time.'); return; }
  const path = `/api/projects/${encodeURIComponent(project.id)}/timeline${timeline.editing ? `/${encodeURIComponent(timeline.editing)}` : ''}`;
  const { response, data } = await api(path, { method: timeline.editing ? 'PATCH' : 'POST', body, timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
  if (!response.ok) { showError(data.error || 'The note was not saved. Check that Promptboard is running.'); return; }
  $('#timeline-note-form').hidden = true;
  announce(timeline.editing ? 'The note was updated.' : 'The note was added to the timeline.');
  timeline.editing = null; timeline.loadedAt = 0; refreshTimeline(project);
}
async function deleteNote(noteId) {
  const project = currentProject();
  const { response, data } = await api(`/api/projects/${encodeURIComponent(project.id)}/timeline/${encodeURIComponent(noteId)}`, { method: 'DELETE', timeoutMs: 30000 }).catch(() => ({ response: { ok: false }, data: {} }));
  if (!response.ok) { $('#timeline-empty').hidden = false; $('#timeline-empty').textContent = data.error || 'The note was not removed.'; return; }
  announce('The note was removed.');
  timeline.loadedAt = 0; refreshTimeline(project);
}
$('#timeline-note-new').addEventListener('click', () => openNoteForm());
$('#note-cancel').addEventListener('click', () => { $('#timeline-note-form').hidden = true; timeline.editing = null; });
$('#timeline-note-form').addEventListener('submit', saveNote);

// ---- Settings ----
// Browser preferences (this browser only) and global server settings (every project). Project
// workflow and Autopilot stay with their project and open in their own dialogs.
const UI_PREFS = { startPage: ['promptboard.settings.start-page', 'compose'], openTerminal: ['promptboard.settings.open-terminal', '1'],
  keepTabs: ['promptboard.settings.keep-tabs', '1'], termFont: ['promptboard.settings.terminal-font', '12'], dockStart: ['promptboard.settings.dock-start', 'last'], cardPreview: ['promptboard.settings.card-preview', '1'], cardAgent: ['promptboard.settings.card-agent', '0'], cardSpacing: ['promptboard.settings.card-spacing', '0'] };
function uiPref(name) {
  const [key, fallback] = UI_PREFS[name];
  const allowed = { startPage: ['compose', 'kanban', 'base'], termFont: ['11', '12', '13', '14', '16'], dockStart: ['last', 'collapsed', 'open'] }[name] || ['0', '1'];
  try { const value = localStorage.getItem(key); return allowed.includes(value) ? value : fallback; } catch { return fallback; }
}
function setUiPref(name, value) { savePref(UI_PREFS[name][0], value); }
function showStartedRun(runId) {
  if (uiPref('openTerminal') === '1') window.PromptboardDock?.open(runId);
  else loadBoard(); // The dock adds a tab for the live run without opening it.
}
function settingsError(message) {
  const error = $('#app-settings-error'); error.textContent = message; error.hidden = !message;
  if (message && $('#app-settings').open) error.scrollIntoView?.({ block: 'nearest' });
}
let settingsSaveQueue = Promise.resolve();
function saveServerSettings(change) {
  const save = async () => {
    settingsError('');
    try { await boardCall('PATCH', '/api/settings', change); return true; }
    catch (error) { settingsError(error.message); return false; }
  };
  settingsSaveQueue = settingsSaveQueue.then(save, save);
  return settingsSaveQueue;
}
function renderSettings() {
  let theme = 'light'; try { theme = localStorage.getItem(THEME_KEY) || 'light'; } catch {}
  $('#set-theme').value = ['system', 'light', 'dark'].includes(theme) ? theme : 'light';
  $('#set-start').value = uiPref('startPage');
  $('#set-open-terminal').checked = uiPref('openTerminal') === '1';
  $('#set-keep-tabs').checked = uiPref('keepTabs') === '1';
  $('#set-term-font').value = uiPref('termFont');
  $('#set-dock-start').value = uiPref('dockStart');
  const settings = board?.settings || {};
  $('#set-max-runs').value = String(settings.maxConcurrentRuns || 1);
  const fields = agentFields(settings.defaultAgent || {}, { inherit: 'Use CLI defaults (Claude Code)' });
  $('#set-base-fields').replaceChildren(basePicker({ target: { scope: 'global' }, provider: settings.defaultAgent?.provider }));
  for (const field of ['provider', 'model', 'effort', 'model-custom']) fields.querySelector(`[data-field="${field}"]`).id = `set-agent-${field}`;
  $('#set-agent-fields').replaceChildren(fields);
  $('#set-agent-save').textContent = 'Save default agent';
  fields.addEventListener('change', () => { $('#set-agent-save').textContent = 'Save default agent'; });
  $('#set-agent-save').disabled = !board;
  $('#set-max-runs').disabled = !board;
  $('#set-card-preview').checked = uiPref('cardPreview') === '1';
  $('#set-card-agent').checked = uiPref('cardAgent') === '1';
  $('#set-card-spacing').checked = uiPref('cardSpacing') === '1';
  const project = currentProject();
  $('#set-project-name').textContent = project?.name || 'no project';
  $('#set-workflow').disabled = !project; $('#set-autopilot').disabled = !project; $('#set-columns').disabled = !project;
  window.PromptboardGitHub?.render();
}
async function openSettings() {
  settingsError('');
  if (!board) await loadBoard().catch(() => {});
  renderSettings();
  if (!$('#app-settings').open) $('#app-settings').showModal();
}
$('#app-settings-open').addEventListener('click', openSettings);
$('#app-settings-close').addEventListener('click', () => $('#app-settings').close());
$('#set-theme').addEventListener('change', () => applyTheme($('#set-theme').value));
window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => { let theme = ''; try { theme = localStorage.getItem(THEME_KEY); } catch {} if (theme === 'system') applyTheme('system'); });
$('#set-start').addEventListener('change', () => setUiPref('startPage', $('#set-start').value));
$('#set-open-terminal').addEventListener('change', () => setUiPref('openTerminal', $('#set-open-terminal').checked ? '1' : '0'));
$('#set-keep-tabs').addEventListener('change', () => { setUiPref('keepTabs', $('#set-keep-tabs').checked ? '1' : '0'); window.PromptboardDock?.sync(); });
$('#set-term-font').addEventListener('change', () => { setUiPref('termFont', $('#set-term-font').value); window.PromptboardDock?.setFontSize(Number($('#set-term-font').value)); });
$('#set-dock-start').addEventListener('change', () => setUiPref('dockStart', $('#set-dock-start').value));
$('#set-clear-tabs').addEventListener('click', () => { const closed = window.PromptboardDock?.closeFinished() || 0; announce(`Closed ${closed} finished ${closed === 1 ? 'tab' : 'tabs'}. Run history is kept.`); });
$('#set-max-runs').addEventListener('change', () => saveServerSettings({ maxConcurrentRuns: Number($('#set-max-runs').value) }));
$('#set-agent-save').addEventListener('click', async () => {
  const button = $('#set-agent-save'); button.disabled = true;
  try {
    if (await saveServerSettings({ defaultAgent: readAgentFields($('#set-agent-fields')) })) { button.textContent = 'Saved'; announce('Global default agent saved. Project and column overrides are kept.'); }
  } finally { button.disabled = !board; }
});
for (const [id, preference] of [['set-card-preview', 'cardPreview'], ['set-card-agent', 'cardAgent'], ['set-card-spacing', 'cardSpacing']]) {
  $(`#${id}`).addEventListener('change', () => { setUiPref(preference, $(`#${id}`).checked ? '1' : '0'); renderBoard(); });
}
$('#set-compose').addEventListener('click', () => {
  $('#app-settings').close(); location.hash = '#/'; showPage(); setSettingsCollapsed(false);
  $('#settings-heading').scrollIntoView?.({ block: 'start' }); $('#settings-toggle').focus();
});
$('#set-columns').addEventListener('click', () => { $('#app-settings').close(); location.hash = '#/kanban'; showPage(); openColumns(); });
// GitHub: sign-in through the GitHub CLI (gh keeps the token), and a repository for the current project.
// The page receives only the user name, the one-time device code, and repository metadata.
const github = { status: null, login: null, results: [], chosen: null, busy: false, message: '' };
const SYNC_TEXT = { up_to_date: 'Up to date', behind: 'Behind', ahead: 'Ahead', needs_attention: 'Needs attention' };
async function githubCall(method, path, body) {
  const { response, data } = await api(path, { method, body, timeoutMs: 600000 });
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The GitHub request failed.');
  if (data.board) { acceptBoard(data.board); renderBoard(); }
  return data;
}
async function githubAction(work) {
  github.busy = true; github.message = ''; renderGitHub();
  try { await work(); } catch (error) { github.message = error.message; }
  finally { github.busy = false; renderGitHub(); }
}
const checkGitHub = () => githubAction(async () => { const data = await githubCall('GET', '/api/github/status'); github.status = data.github; github.login = data.login; });
function pollLogin() {
  clearTimeout(pollLogin.timer);
  if (!['starting', 'waiting'].includes(github.login?.status)) return;
  pollLogin.timer = setTimeout(async () => {
    try { github.login = (await githubCall('GET', '/api/github/login')).login; } catch { return; }
    renderGitHub();
    if (github.login.status === 'done') checkGitHub(); else pollLogin();
  }, 2000);
}
function renderGitHub() {
  const box = $('#set-github-group');
  const legend = box.querySelector('legend');
  const nodes = [];
  const st = github.status;
  const state = !st ? 'Not checked yet' : !st.installed ? 'GitHub CLI not installed' : st.state === 'connected' ? `Connected as @${st.user}` : st.state === 'needs_attention' ? 'Needs attention' : 'Not connected';
  nodes.push(paragraph(`Status: ${state}${st?.message ? `. ${st.message}` : ''}`, 'github-status'));
  const buttons = [detailButton(github.busy ? 'Checking…' : 'Check connection', checkGitHub, 'secondary-button')];
  const login = github.login;
  if (st?.installed && st.state !== 'connected' && !['starting', 'waiting'].includes(login?.status)) {
    buttons.push(detailButton('Connect GitHub', () => githubAction(async () => { github.login = (await githubCall('POST', '/api/github/login', {})).login; pollLogin(); }), 'danger'));
  }
  nodes.push(detailActions(...buttons));
  if (['starting', 'waiting'].includes(login?.status)) {
    const code = document.createElement('code'); code.className = 'github-code'; code.textContent = login.code || '…';
    const p = document.createElement('p'); p.className = 'note';
    p.append('Enter this one-time code on GitHub: ', code, ' ', externalLink(login.url, 'Open github.com/login/device'), '. The GitHub CLI keeps the sign-in; Promptboard never sees a token.');
    nodes.push(p, detailActions(detailButton('Cancel sign-in', () => githubAction(async () => { github.login = (await githubCall('POST', '/api/github/login/cancel', {})).login; }))));
  } else if (['failed', 'cancelled'].includes(login?.status) && login.message) nodes.push(paragraph(login.message, 'inline-error'));
  if (!st?.installed && st) nodes.push(paragraph('Install the GitHub CLI from cli.github.com, then choose Check connection.', 'note'));
  nodes.push(paragraph('To sign the GitHub CLI out everywhere, run gh auth logout in your terminal. Disconnecting a repository below never signs you out.', 'note'));
  const project = currentProject();
  if (project) nodes.push(renderProjectGitHub(project));
  if (github.message) nodes.push(paragraph(github.message, 'inline-error'));
  box.replaceChildren(legend, ...nodes);
  for (const button of box.querySelectorAll('button')) button.disabled ||= github.busy;
  // Results re-render the section; keep typing in the search field.
  if (github.typing && $('#github-search')) { const input = $('#github-search'); input.focus(); input.setSelectionRange?.(input.value.length, input.value.length); }
}
function renderProjectGitHub(project) {
  const section = document.createElement('div');
  section.className = 'github-project';
  const title = document.createElement('p'); title.className = 'field-label'; title.textContent = `Repository for ${project.name}`;
  section.append(title);
  const gh = project.github;
  if (gh) {
    const sync = gh.sync ? `${SYNC_TEXT[gh.sync.sync] || 'Unknown'}${gh.sync.behind ? ` ${gh.sync.behind}` : ''}${gh.sync.sync === 'ahead' ? ` ${gh.sync.ahead}` : ''}` : 'Not fetched yet';
    section.append(paragraph(`GitHub: ${gh.nameWithOwner}${gh.private ? ' (private)' : ' (public)'} · Target: ${project.targetBranch?.name || 'not set'} · Remote: ${gh.remote} · Sync: ${sync}${gh.lastFetchAt ? ` · Fetched ${timeAgo(gh.lastFetchAt)}` : ''}`, 'github-repo'));
    if (gh.sync?.message) section.append(paragraph(gh.sync.message, 'note'));
    section.append(paragraph(`Managed clone: ${gh.clonePath}`, 'note'));
    const row = detailActions(
      detailButton('Fetch', () => githubAction(() => githubCall('POST', `/api/projects/${encodeURIComponent(project.id)}/github-fetch`, {}))),
      ...(gh.sync?.sync === 'behind' ? [detailButton(`Update ${project.targetBranch?.name}…`, () => confirmStep(row, `Fast-forward ${project.targetBranch?.name} to origin? Only a fast-forward is allowed; nothing is merged, reset, or discarded.`, 'Update', () => githubAction(() => githubCall('POST', `/api/projects/${encodeURIComponent(project.id)}/github-update`, { confirm: true }))))] : []),
      externalLink(gh.url, 'Open on GitHub'),
      detailButton('Disconnect…', () => confirmStep(row, 'Disconnect this project from GitHub? The managed clone, its worktrees, and all local work stay. The GitHub CLI stays signed in.', 'Disconnect', () => githubAction(() => githubCall('DELETE', `/api/projects/${encodeURIComponent(project.id)}/github?expectedRevision=${project.revision}`)))));
    section.append(row);
    return section;
  }
  if (github.status?.state !== 'connected') { section.append(paragraph('Connect GitHub first to use a GitHub repository. Local folders work without GitHub.', 'note')); return section; }
  const label = document.createElement('label'); label.className = 'field-label'; label.textContent = 'Search your repositories';
  const search = document.createElement('input'); search.type = 'search'; search.id = 'github-search'; search.maxLength = 100; search.placeholder = 'owner/name'; search.autocomplete = 'off';
  search.value = github.query || '';
  label.append(search);
  const list = document.createElement('ul'); list.className = 'github-results';
  for (const repo of github.results) {
    const item = document.createElement('li');
    const pick = detailButton(`${repo.nameWithOwner} · ${repo.private ? 'private' : 'public'} · ${repo.defaultBranch || 'no default branch'}`, () => { github.chosen = repo; github.branch = repo.defaultBranch; renderGitHub(); }, 'github-result');
    pick.setAttribute('aria-pressed', String(github.chosen?.nameWithOwner === repo.nameWithOwner));
    item.append(pick); list.append(item);
  }
  let timer;
  search.addEventListener('blur', () => { github.typing = false; });
  search.addEventListener('input', () => { github.typing = true; clearTimeout(timer); timer = setTimeout(() => { github.query = search.value.trim(); githubAction(async () => { github.results = (await githubCall('GET', `/api/github/repos?q=${encodeURIComponent(github.query)}`)).repositories; }); }, 300); });
  section.append(label, list);
  if (github.chosen) {
    const branchLabel = document.createElement('label'); branchLabel.className = 'field-label'; branchLabel.textContent = 'Target branch';
    const branch = document.createElement('input'); branch.id = 'github-branch'; branch.maxLength = 255; branch.value = github.branch || '';
    branch.addEventListener('input', () => { github.branch = branch.value.trim(); });
    branchLabel.append(branch);
    section.append(branchLabel, paragraph(`Promptboard clones ${github.chosen.nameWithOwner} into its data folder and links that clone to this project. Agents work in task worktrees of the clone. ${project.repository ? 'This replaces the current repository link.' : ''}`, 'note'),
      detailActions(detailButton('Connect repository', () => githubAction(async () => {
        await githubCall('POST', `/api/projects/${encodeURIComponent(project.id)}/github`, { repository: github.chosen.nameWithOwner, branch: github.branch || '', expectedRevision: project.revision });
        github.chosen = null; github.results = []; github.query = '';
        announce('The GitHub repository is connected.');
      }), 'danger')));
  }
  return section;
}
window.PromptboardGitHub = { render: () => { renderGitHub(); if (!github.status && !github.busy) checkGitHub(); } };

$('#set-workflow').addEventListener('click', () => { $('#app-settings').close(); if (location.hash !== '#/kanban') location.hash = '#/kanban'; openWorkflowDialog(); });
$('#set-autopilot').addEventListener('click', () => { $('#app-settings').close(); if (location.hash !== '#/kanban') location.hash = '#/kanban'; openAutopilot(); });
$('#autopilot-close').addEventListener('click', () => $('#autopilot-dialog').close());
$('#autopilot-finish').addEventListener('change', () => { autopilotDraft.finish = $('#autopilot-finish').value; });
$('#autopilot-rework').addEventListener('change', () => { autopilotDraft.maxRework = Number($('#autopilot-rework').value); });
$('#autopilot-save').addEventListener('click', () => saveAutopilot(false));
$('#autopilot-form').addEventListener('submit', event => { event.preventDefault(); saveAutopilot(true); });

// Base owns its own metadata/content requests, with only these explicit application seams.
baseView = window.PromptboardBase?.create({ api, announce, ensureBoard: loadBoard, refreshBoard: loadBoard, agentFields, readAgentFields, closeSidebar: () => setSidebar(false),
  acceptBoard: next => { acceptBoard(next); renderBoard(); } }) || null;
window.PromptboardBaseView = baseView;
// Start page applies only when the URL contains no explicit route.
if (!location.hash && uiPref('startPage') !== 'compose') location.hash = `#/${uiPref('startPage')}`;
showPage();
loadProviders();
$('#settings-toggle').addEventListener('click', () => setSettingsCollapsed(!$('#settings-body').hidden));
$('#project-toggle').addEventListener('click', () => setProjectCollapsed(!$('#project-body').hidden));
$('#project-settings-close').addEventListener('click', () => setProjectCollapsed(true));
$('#project-settings').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); setProjectCollapsed(true); }
});

// Sideways movement on a board wider than the window: ‹ › buttons, a visible scrollbar,
// swipes and Shift+wheel (native), and dragging on empty board space with a mouse.
function updateBoardScroll() {
  const columns = $('#kanban-columns');
  const max = columns.scrollWidth - columns.clientWidth;
  const left = columns.scrollLeft > 2, right = columns.scrollLeft < max - 2;
  $('#board-left').disabled = !left;
  $('#board-right').disabled = !right;
  $('#board-left').hidden = $('#board-right').hidden = columns.hidden || max <= 2;
  columns.classList.toggle('more-left', left);
  columns.classList.toggle('more-right', right);
}
function scrollBoard(direction) {
  const columns = $('#kanban-columns');
  const step = columns.querySelector('.kanban-column')?.getBoundingClientRect().width || 280;
  columns.scrollBy({ left: direction * (step + 10), behavior: scrollBehavior() });
}
$('#board-left').addEventListener('click', () => scrollBoard(-1));
$('#board-right').addEventListener('click', () => scrollBoard(1));
$('#kanban-columns').addEventListener('scroll', updateBoardScroll, { passive: true });
window.addEventListener('resize', updateBoardScroll);
{
  let pan = null;
  const columns = $('#kanban-columns');
  columns.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.kanban-card, button, select, input, textarea, a')) return;
    pan = { x: event.clientX, left: columns.scrollLeft, id: event.pointerId, moved: false };
  });
  columns.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.id) return;
    const dx = event.clientX - pan.x;
    if (!pan.moved && Math.abs(dx) < 4) return;
    if (!pan.moved) { pan.moved = true; columns.setPointerCapture(pan.id); columns.classList.add('panning'); }
    columns.scrollLeft = pan.left - dx;
  });
  const stop = () => { if (pan?.moved) columns.classList.remove('panning'); pan = null; };
  columns.addEventListener('pointerup', stop);
  columns.addEventListener('pointercancel', stop);
}
try { if (localStorage.getItem(SETTINGS_KEY) === 'collapsed') setSettingsCollapsed(true, false); } catch {}
try { setProjectCollapsed(localStorage.getItem(PROJECT_PANEL_KEY) !== 'expanded', false); } catch { setProjectCollapsed(true, false); }
window.addEventListener('resize', fitBoardHeight);
if (typeof ResizeObserver === 'function') {
  const observer = new ResizeObserver(fitBoardHeight);
  // Some browsers expose a resized dock's new geometry only after the layout commits.
  for (const id of ['project-context', 'project-body', 'autopilot-bar', 'dock', 'kanban-columns']) observer.observe($(`#${id}`));
}
// A required field inside a collapsed card would block submit without a visible message. Reopen it.
$('#settings-body').addEventListener('invalid', () => setSettingsCollapsed(false, false), true);

// Read-only provider usage. Poll independently of board updates, once per minute.
let usageLoading = false;
function usageChart(points) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 52'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily token usage over the last 30 days'); svg.classList.add('usage-chart');
  const max = Math.max(1, ...points.map(p => p.tokens));
  points.forEach((point, index) => {
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(index * 10)); rect.setAttribute('y', String(50 - point.tokens / max * 48));
    rect.setAttribute('width', '7'); rect.setAttribute('height', String(point.tokens ? Math.max(1, point.tokens / max * 48) : 1));
    rect.setAttribute('rx', '1');
    const title = document.createElementNS(ns, 'title'); title.textContent = `${point.day}: ${point.tokens.toLocaleString()} tokens`; rect.append(title); svg.append(rect);
  });
  return svg;
}
function renderUsage(data) {
  const open = new Set([...$('#usage-providers').querySelectorAll('details[open]')].map(x => x.dataset.provider));
  const content = document.createDocumentFragment();
  for (const provider of data.providers) {
    const section = document.createElement('section'); section.className = 'usage-provider';
    const head = document.createElement('h3'); head.textContent = provider.name; section.append(head);
    const limits = provider.limits;
    if (limits.windows.length) {
      for (const window of limits.windows) {
        const label = document.createElement('p'); label.className = 'usage-limit-label';
        const remaining = document.createElement('strong'); remaining.textContent = `${Math.round(window.remainingPercent)}% left`;
        const meta = document.createElement('span'); meta.textContent = window.windowMinutes ? `${window.label} · ${window.windowMinutes >= 1440 ? `${Math.round(window.windowMinutes / 1440)}d` : window.windowMinutes < 60 ? `${window.windowMinutes}m` : `${window.windowMinutes / 60}h`} window` : window.label.replaceAll('_', ' ');
        label.append(remaining, meta);
        const bar = document.createElement('progress'); bar.max = 100; bar.value = window.remainingPercent; bar.setAttribute('aria-label', `${meta.textContent}: ${remaining.textContent}`);
        section.append(label, bar);
        if (window.resetsAt) section.append(paragraph(`Resets ${new Date(window.resetsAt).toLocaleString()}`, 'usage-muted'));
      }
      const age = limits.checkedAt ? ` · ${timeAgo(limits.checkedAt)}` : '';
      section.append(paragraph(`${limits.status === 'live' ? 'Live account limits' : 'Last reported limits'}${age}${limits.note ? ` · ${limits.note}` : ''}`, 'usage-muted'));
    } else section.append(paragraph(limits.note || 'Plan limits unavailable.', 'usage-muted'));
    const total = provider.inputTokens + provider.cachedTokens + provider.outputTokens;
    const summary = document.createElement('div'); summary.className = 'usage-metrics';
    summary.append(paragraph(provider.sessions ? `${tokens(total)} tokens` : 'No local token data', 'usage-total'), paragraph(`${provider.sessions} sessions`, 'usage-muted'), paragraph(provider.costUSD === null ? 'Cost not reported' : `$${provider.costUSD.toFixed(2)} reported estimate`, 'usage-muted'));
    section.append(summary);
    if (provider.sessions) section.append(usageChart(provider.daily));
    if (provider.partial) section.append(paragraph('Partial coverage: some session files exceeded scan limits or could not be read.', 'inline-error'));
    const details = document.createElement('details'); details.dataset.provider = provider.id; details.open = open.has(provider.id);
    const toggle = document.createElement('summary'); toggle.textContent = 'Models and tools'; details.append(toggle);
    if (provider.models.length) {
      const table = document.createElement('table'); table.className = 'usage-table';
      const header = document.createElement('tr');
      for (const text of ['Model', 'Input', 'Cached', 'Output']) { const th = document.createElement('th'); th.textContent = text; th.scope = 'col'; header.append(th); }
      table.append(header);
      for (const model of provider.models) {
        const row = document.createElement('tr');
        for (const text of [model.model, tokens(model.inputTokens), tokens(model.cachedTokens), tokens(model.outputTokens)]) { const td = document.createElement('td'); td.textContent = text; row.append(td); }
        table.append(row);
      }
      const wrapper = document.createElement('div'); wrapper.className = 'usage-table-wrap'; wrapper.append(table); details.append(wrapper);
    } else details.append(paragraph('No local model usage reported.', 'usage-muted'));
    if (provider.tools.length) {
      const tools = document.createElement('div'); tools.className = 'usage-tools';
      for (const tool of provider.tools) tools.append(paragraph(`${tool.name} · ${tool.count.toLocaleString()}`, 'usage-muted'));
      details.append(tools);
    } else details.append(paragraph('Tool counts not reported.', 'usage-muted'));
    details.append(paragraph(provider.costNote, 'usage-muted'));
    section.append(details); content.append(section);
  }
  $('#usage-providers').replaceChildren(content);
  $('#usage-updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleTimeString()} · every minute`;
}
async function loadUsage(force = false) {
  if (usageLoading || !$('#usage-dialog').open) return;
  usageLoading = true; $('#usage-refresh').disabled = true;
  try { const { response, data } = await api(`/api/usage${force ? '?refresh=1' : ''}`, { timeoutMs: 60000 }); if (!response.ok) throw new Error(data.error || 'Usage unavailable.'); renderUsage(data); $('#usage-error').hidden = true; }
  catch (error) { $('#usage-error').textContent = `${error.message} Previously shown figures may be stale.`; $('#usage-error').hidden = false; }
  finally { usageLoading = false; $('#usage-refresh').disabled = false; }
}
$('#usage-open').addEventListener('click', () => { $('#usage-dialog').showModal(); loadUsage(); });
$('#usage-close').addEventListener('click', () => { $('#usage-dialog').close(); $('#usage-open').focus(); });
$('#usage-dialog').addEventListener('close', () => $('#usage-open').focus());
$('#usage-refresh').addEventListener('click', () => loadUsage(true));
setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUsage(); });
