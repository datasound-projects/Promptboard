'use strict';

const $ = (selector) => document.querySelector(selector);
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const THEME_KEY = 'ste-prompt-engineer.theme'; // Also read by prefs.js before first paint.
const SIDEBAR_KEY = 'ste-prompt-engineer.sidebar';
const SETTINGS_KEY = 'ste-prompt-engineer.settings';
const PROJECT_PANEL_KEY = 'promptboard.project-panel';
const HISTORY_LIMIT = 40;
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
const STAGE_LABELS = { starting: 'Starting', models: 'Checking model options', draft: 'Drafting', review: 'Reviewing', repair: 'Repairing', 'repair-review': 'Reviewing the repair' };

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
  const reviewStatus = ['pass', 'issues', 'unavailable', 'skipped'].includes(review.status) ? review.status : 'unavailable';
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
    repaired: value.repaired === true, repairFailed: value.repairFailed === true, calls: nonnegative(value.calls), engineVersion: safeText(value.engineVersion, 100),
    stages: list(value.stages, item => ({ stage: safeText(item.stage, 100), reportedModels: Array.isArray(item.reportedModels) ? item.reportedModels.filter(model => typeof model === 'string').map(model => safeText(model, 100)) : [], durationMs: nonnegative(item.durationMs), status: safeText(item.status, 100) })),
    promptHash: safeText(value.promptHash, 200), inputHash: safeText(value.inputHash, 200), instructionsHash: safeText(value.instructionsHash, 200),
    timings: { totalMs: nonnegative(value.timings?.totalMs), modelMs: nonnegative(value.timings?.modelMs), checksMs: nonnegative(value.timings?.checksMs) },
    reviewRequired: true,
  };
}

function announce(message) { $('#announcement').textContent = message; }

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    $('#storage-warning').hidden = true;
    return true;
  } catch {
    $('#storage-warning').hidden = false;
    return false;
  }
}

function renderHistory() {
  const query = $('#history-search').value.trim().toLowerCase();
  const filtered = history.filter((entry) => !query || `${entry.input} ${entry.prompt}`.toLowerCase().includes(query));
  $('#history-list').replaceChildren();
  $('#history-count').textContent = String(history.length).padStart(2, '0');
  $('#history-empty').hidden = filtered.length > 0;
  $('#history-empty p').textContent = query ? 'No matches. The nerd checked twice.' : 'No prompts yet. Suspiciously tidy.';
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
  $('#project-body').hidden = collapsed;
  $('.kanban-projects').classList.toggle('collapsed', collapsed);
  const label = collapsed ? 'Expand project settings' : 'Collapse project settings';
  $('#project-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#project-toggle').setAttribute('aria-label', label);
  $('#project-toggle').title = label;
  $('#project-toggle span').textContent = collapsed ? '+' : '−';
  $('#project-summary').hidden = !collapsed;
  if (save) savePref(PROJECT_PANEL_KEY, collapsed ? 'collapsed' : 'expanded');
}
function scrollBehavior() { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth'; }
function renderTheme() { $('#theme-toggle').setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark')); }
function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  savePref(THEME_KEY, dark ? 'dark' : 'light');
  renderTheme();
}

// Narrow screens show history as a drawer (.open); wider screens collapse it in place (data-sidebar).
function isMobile() { return window.innerWidth <= 730; }
function syncSidebarToggle() {
  const expanded = isMobile() ? $('#sidebar').classList.contains('open') : document.documentElement.dataset.sidebar !== 'collapsed';
  $('#menu-toggle').setAttribute('aria-expanded', String(expanded));
  $('#menu-toggle').setAttribute('aria-label', expanded ? 'Hide prompt history' : 'Show prompt history');
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
    if (open) $('#new-prompt').focus();
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
  $('#cli-status-label').textContent = availableCount ? `${availableCount} CLI${availableCount === 1 ? '' : 's'} connected` : 'Connect a CLI';
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
    ? 'Automatic checks and a separate model review. Usually 2 CLI calls; up to 4 if one repair is needed. Uses more time and CLI allowance.'
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
  $('#output-card').setAttribute('aria-busy', String(value));
  $('#generation-progress').hidden = !value;
  $('#cancel-button').hidden = !value;
  $('#generate-label').textContent = value ? 'Writing and checking…' : "Okay, let's goooo!";
  $('#cancel-button').disabled = false;
  $('#new-prompt').disabled = value;
  $('#load-example').disabled = value;
  for (const input of $('#prompt-form').querySelectorAll('input,select,textarea')) input.disabled = value;
  $('#copy-button').disabled = value || !currentResult;
  $('#export-button').disabled = value || !currentResult;
  $('#kanban-button').disabled = value || !currentResult;
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

function clearOutput() {
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
  $('#report-button').disabled = true;
  $('#generation-error').hidden = true;
}

function showResult(result) {
  currentResult = result;
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
  $('#verification-summary').textContent = `${report.calls} CLI ${report.calls === 1 ? 'call' : 'calls'}${report.repaired ? ' · one repair' : ''}`;
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
    item.textContent = `${stage.stage.replace(/[-_]/g, ' ')}: ${stage.status} · ${seconds(stage.durationMs)} · ${stage.reportedModels.length ? `models reported: ${stage.reportedModels.join(', ')}` : 'actual model not reported by CLI'}`;
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
    announce(`${resultMessage}${saved ? '' : ' Browser history was not saved. Copy or export this prompt and its check report to keep them.'}`);
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
      showAuthDetail(paragraph(operation?.code === 'UNSUPPORTED' ? 'This CLI does not support sign-in from this app.' : failureMessage(data, 'The CLI could not start sign-in. Try the terminal command instead.')),
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
      : operation?.code === 'TIMEOUT' ? 'Sign-in timed out. Try again.' : 'Sign-in did not complete. Try again, or use the terminal command.'));
    await afterAuthChange(state === 'succeeded' ? 'Signed in. Model list refreshed.' : '');
  } catch {
    if (!finished) { showAuthDetail(paragraph('The local server did not respond. Check that the app is still running.')); await afterAuthChange(); }
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
      showAuthDetail(paragraph(response.ok ? `${name} is signed out.` : failureMessage(data, 'The CLI could not sign out. Use its terminal command.')));
      await afterAuthChange(response.ok ? `${name} signed out.` : '');
    } catch {
      showAuthDetail(paragraph('The local server did not respond. Check that the app is still running.'));
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
    content.append(
      paragraph('This app saves your last 40 finished prompts in this browser’s local storage. You can delete them in the sidebar. The Kanban board is saved by the local app in its data folder on this computer, not in the browser.'),
      paragraph('The Kanban page stores, moves, and copies cards. It does not send cards to a CLI or model; agent runs are not active yet.'),
      paragraph('When you generate a prompt, your text goes to the local server, then to your selected CLI. That CLI may send it to its model provider under your account and that provider’s policies. Do not include secrets or private information that you cannot share with that provider.'),
      paragraph('The app does not need a separate API key. The CLI must be installed and signed in. Its account limits and applicable usage costs still apply.'),
      paragraph('Reviewed mode usually makes 2 CLI calls and can make up to 4 after one repair. Fast mode makes 1 call. The check report and original request stay with the prompt in browser history.'),
      paragraph('Automatic checks cover specific rules. Model review is fallible. This app does not include the ASD-STE100 dictionary and does not certify STE compliance.', 'dialog-note'),
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

// Pages. Both views stay in the document, so switching never clears the prompt form.
function showPage() {
  const kanban = location.hash === '#/kanban';
  $('#prompt-view').hidden = kanban;
  $('#kanban-view').hidden = !kanban;
  for (const link of document.querySelectorAll('.page-nav a')) {
    if ((link.getAttribute('href') === '#/kanban') === kanban) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = kanban ? 'Kanban · Promptboard' : 'Compose · Promptboard';
  if (kanban) renderBoard();
  setSidebar(false);
  window.scrollTo(0, 0);
}
function showPromptPage() { if (location.hash === '#/kanban') location.hash = '#/'; }

// Kanban (PB-01): the local app stores the board in its data folder. Seven fixed stages;
// cards move through transitions the server validates. Nothing on this page starts an agent.
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
const pendingMoves = new Set(); // Cards moved locally while the server confirms the move.
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
function columnTitle(id) { return board?.columns.find(column => column.id === id)?.title || id; }
function selectedProjectId() { try { return localStorage.getItem(SELECTED_PROJECT_KEY); } catch { return null; } }
function currentProject() { return board?.projects.find(project => project.id === selectedProjectId()) || board?.projects[0] || null; }
function findTask(id) { return currentProject()?.tasks.find(task => task.id === id) || null; }

// Mirrors the server rule so the menu offers only valid moves. The server still decides.
function canMove(from, to) {
  const ids = board.columns.map(column => column.id);
  const a = ids.indexOf(from), b = ids.indexOf(to);
  if (a < 0 || b < 0 || a === b) return false;
  if (from === 'done') return to === 'todo';
  if (to === 'done') return false; // Reached only through a merge or an explicit no-change completion.
  return b === a + 1 || (from === 'todo' && to === 'executing') || b < a;
}

function setBoardWarning(message) {
  for (const warning of document.querySelectorAll('.board-warning')) { warning.textContent = message; warning.hidden = !message; }
}

/** One board request. On success the server returns the whole board, which replaces ours. */
async function boardCall(method, path, body, timeoutMs = 60000) {
  let result;
  try { result = await api(path, { method, body, timeoutMs }); }
  catch { setBoardWarning('The app did not answer, so the change was not saved. Check that Promptboard is still running.'); throw new Error('The app did not answer. The change was not saved.'); }
  const { response, data } = result;
  if (data.board) board = data.board;
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

async function loadBoard() {
  if (!token) return;
  boardLoading ??= (async () => {
    try {
      const { response, data } = await api('/api/board', { timeoutMs: 30000 });
      if (!response.ok || !data.board) throw new Error(typeof data.error === 'string' ? data.error : 'The app could not read the board.');
      board = data.board;
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
  const project = currentProject();
  const tasks = project?.tasks || [];
  $('#project-select').replaceChildren(...(board?.projects || []).map(item => option(item.id, item.name)));
  if (!project) $('#project-select').append(option('', board ? 'No projects yet' : 'Loading…'));
  $('#project-select').value = project?.id || '';
  $('#project-select').disabled = !project;
  $('#project-new').disabled = !board;
  for (const id of ['#project-rename', '#project-delete', '#card-new']) $(id).disabled = !project;
  $('#board-count').textContent = String(tasks.length).padStart(2, '0');
  $('#board-empty').hidden = tasks.length > 0;
  $('#board-empty-text').textContent = !board ? 'Loading the board…' : project ? 'No tasks yet.' : 'Create a project to start planning.';
  $('#board-empty-note').textContent = project ? 'Choose New card, or add a generated prompt from the Compose page. New cards start in To Do.' : 'Each project gets its own board, from To Do to Done.';
  $('#empty-prompt-link').hidden = !project;
  $('#kanban-columns').hidden = !project;
  // Missing terminal support never blocks the board or the prompt editor; it only disables runs.
  $('#execution-status').hidden = !board || board.execution?.available !== false || !board.execution.setupMessage;
  $('#execution-status').textContent = board?.execution?.setupMessage ? `Agent runs are unavailable. ${board.execution.setupMessage}` : '';
  $('#kanban-columns').replaceChildren(...(project ? board.columns.map(column => renderColumn(column, tasks.filter(task => task.column === column.id))) : []));
  renderRepository(project);
  const branch = project?.targetBranch?.name;
  $('#project-summary').textContent = project ? [project.name, project.repository ? project.repository.root.split(/[\\/]/).pop() + (branch ? ` → ${branch}` : '') : 'Not linked', workflowSummary(project)].join(' · ') : '';
  $('#project-summary').title = $('#project-summary').textContent;
  // Without a project the settings are the only way forward, so they stay open.
  if (!project && $('#project-body').hidden) setProjectCollapsed(false, false);
  updateBoardScroll();
  window.PromptboardDock?.sync();
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
};
function stageIcon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'kanban-stage-icon' })) svg.setAttribute(name, value);
  for (const d of STAGE_ICONS[id] || []) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}

function renderColumn(column, tasks) {
  const section = document.createElement('section');
  section.className = 'kanban-column';
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
  const note = paragraph(!column.agent ? (column.id === 'todo' ? 'Never runs an agent' : 'Finished · never runs an agent')
    : !board.execution?.available ? 'Agent stage · agent terminals not set up' : { testing: 'Your test commands · only exit codes count', merge: 'Fast-forward only · never pushed' }[column.id] || 'Agent stage · starts only when you choose', 'kanban-column-note');
  const list = document.createElement('ol');
  list.className = 'kanban-cards';
  list.dataset.column = column.id;
  list.setAttribute('aria-labelledby', heading.id);
  list.append(...tasks.map((task, index) => renderCard(task, index, tasks.length)));
  // Dropping on empty column space puts the card at the end of that column.
  list.addEventListener('dragover', event => { if (dragId && event.target === list) { event.preventDefault(); list.classList.add('drop-target'); } });
  list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
  list.addEventListener('drop', event => {
    if (event.target !== list || !dragId) return;
    event.preventDefault();
    const id = dragId; dragId = null;
    placeCard(id, column.id, tasks.filter(task => task.id !== id).length);
  });
  section.append(header, note, list);
  return section;
}

function latestRun(taskId) { return board.runs.filter(run => run.taskId === taskId).at(-1) || null; }

function renderCard(card, index, count) {
  const status = cardStatus(card);
  const item = document.createElement('li');
  item.className = `kanban-card${status.flag ? ' needs-review' : ''}`;
  item.dataset.id = card.id;
  item.draggable = true;
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
  moveTo.append(option('', 'Move to…'), ...board.columns.filter(column => canMove(card.column, column.id)).map(column => option(column.id, column.title)));
  moveTo.addEventListener('change', () => { if (moveTo.value) placeCard(card.id, moveTo.value, null); });
  const copy = labelled(detailButton('Copy prompt', () => copyCard(card, copy), 'kanban-copy'), `Copy prompt: ${card.title}`);
  // Less frequent actions sit behind "⋯" so each card stays short and a column shows more cards.
  const more = document.createElement('div');
  more.className = 'kanban-more';
  more.id = `card-more-${card.id}`;
  more.hidden = true;
  more.append(copy,
    labelled(detailButton('Duplicate', () => duplicateCard(card.id), 'kanban-duplicate'), `Duplicate: ${card.title}`),
    labelled(detailButton('Delete', () => confirmCardDelete(item, card), 'kanban-delete'), `Delete: ${card.title}`));
  const toggle = labelled(detailButton('⋯', () => { more.hidden = !more.hidden; toggle.setAttribute('aria-expanded', String(!more.hidden)); }, 'kanban-more-toggle'), `More actions: ${card.title}`);
  toggle.title = 'Copy, duplicate, or delete';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', more.id);
  const actions = document.createElement('div');
  actions.className = 'kanban-actions';
  actions.append(up, down, moveTo, toggle);
  const details = [card.source ? sourceSummary(card.source) : 'Written by you'];
  if (card.workspace) details.push(`Branch ${card.workspace.branch}${card.workspace.status === 'ready' ? '' : ` (${card.workspace.status})`}`);
  const run = latestRun(card.id);
  const meta = paragraph(details.join(' · '), 'kanban-meta');
  meta.title = meta.textContent;
  item.append(badge, heading, paragraph(card.prompt.slice(0, 400).replace(/\s+/g, ' ').trim(), 'kanban-preview'), meta, renderRunControls(card, run), actions, more);
  if (pendingMoves.has(card.id)) item.classList.add('pending');
  // Selecting a card reveals its agent session, if it has one.
  item.addEventListener('click', event => { if (!event.target.closest('button, select, a')) window.PromptboardDock?.reveal(card.id); });
  // Pointer drag-and-drop. The ↑/↓ buttons and the stage menu are the keyboard equivalent.
  item.addEventListener('dragstart', event => {
    dragId = card.id;
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.title); }
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    dragId = null;
    for (const element of document.querySelectorAll('.kanban-card.dragging, .drop-target')) element.classList.remove('dragging', 'drop-target');
  });
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
async function placeCard(id, column, index, retried = false) {
  const card = findTask(id);
  if (!card || pendingMoves.has(id)) return false;
  const project = currentProject();
  const others = project.tasks.filter(task => task.column === column && task.id !== id);
  const position = index === null ? others.length : Math.min(index, others.length);
  const snapshot = project.tasks.slice();
  const rest = project.tasks.filter(task => task.id !== id);
  const before = rest.filter(task => task.column === column)[position];
  const at = before ? rest.indexOf(before) : (others.length ? rest.indexOf(others.at(-1)) + 1 : rest.length);
  rest.splice(at, 0, { ...card, column });
  project.tasks = rest;
  pendingMoves.add(id);
  renderBoard();
  let result;
  try {
    result = await boardCall('POST', `/api/tasks/${encodeURIComponent(id)}/move`, { column, index: position, expectedRevision: card.revision });
  } catch (error) {
    pendingMoves.delete(id);
    // Background work (for example test results) can change a card's revision. If the card is still
    // where the user saw it, the move they asked for is unchanged: reload and try once more.
    if (error.code === 'REVISION_CONFLICT' && !retried && findTask(id)?.column === card.column) return placeCard(id, column, index, true);
    if (currentProject()?.id === project.id && error.code !== 'REVISION_CONFLICT' && error.code !== 'NOT_FOUND') { currentProject().tasks = snapshot; renderBoard(); }
    cardElement(id)?.classList.add('rejected');
    showMoveError(card, column, error);
    return false;
  }
  pendingMoves.delete(id);
  renderBoard();
  announce(column === card.column ? `Moved “${card.title}” to position ${position + 1} of ${others.length + 1}.` : `Moved “${card.title}” to ${columnTitle(column)}. Moving a card does not run or approve that stage.`);
  if (result.run) { announce(`Moved “${card.title}” to ${columnTitle(column)}. The workflow setting started an agent run.`); window.PromptboardDock?.open(result.run.id); }
  if (result.merged) announce(`“${card.title}” passed every check and was merged automatically into ${result.task?.completion?.targetBranch || 'the target branch'}. Nothing was pushed.`);
  if (result.automation) showProjectDetail(paragraph(column === 'merge' ? `Moved to Merge. ${result.automation.message}` : `Moved to ${columnTitle(column)}, but the automatic start did not happen: ${result.automation.message}`, 'kanban-error'));
  if (result.ask) askToStart(findTask(id), result.ask.stage);
  return true;
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

function confirmCardDelete(item, card) {
  const keep = detailButton('Keep card', () => { renderBoard(); cardElement(card.id)?.querySelector('.kanban-more-toggle').focus(); });
  const confirm = document.createElement('div');
  confirm.className = 'connection-detail kanban-confirm';
  const note = card.workspace ? ' Its worktree is removed only if it has no uncommitted changes; its branch is kept.' : '';
  confirm.append(paragraph(`Delete “${card.title}”? This cannot be undone.${note}`), detailActions(detailButton('Delete card', () => deleteCard(card.id), 'danger'), keep));
  item.querySelector('.kanban-more').remove();
  item.querySelector('.kanban-actions').replaceWith(confirm);
  keep.focus();
}

async function deleteCard(id) {
  const card = findTask(id);
  if (!card) return;
  try { await boardCall('DELETE', `/api/tasks/${encodeURIComponent(id)}?expectedRevision=${card.revision}`); }
  catch (error) { renderBoard(); showBoardError(error); return; }
  announce(`Deleted “${card.title}”.`);
  ($('#kanban-columns .kanban-open') || $('#card-new')).focus();
}

function openCard(id = null) {
  const project = currentProject();
  if (!project) return;
  const card = id ? project.tasks.find(item => item.id === id) : null;
  editingCardId = card?.id || null;
  $('#card-dialog-project').textContent = `${project.name} · ${columnTitle(card?.column || 'todo')}`;
  $('#card-dialog-heading').textContent = card ? 'Edit card' : 'New card';
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
  $('#card-title').focus();
}

async function saveCard(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const card = editingCardId ? project.tasks.find(item => item.id === editingCardId) : null;
  const title = $('#card-title').value.trim();
  const typed = $('#card-prompt').value;
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
}

function openProjectForm(mode) {
  projectFormMode = mode;
  showProjectDetail();
  $('#project-form-label').textContent = mode === 'rename' ? 'Rename project' : 'New project name';
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
      const created = (await boardCall('POST', '/api/projects', { name })).project;
      savePref(SELECTED_PROJECT_KEY, created.id);
      renderBoard();
      announce(`Created project “${name}”.`);
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
const STAGE_VERBS = { planning: 'Start planning', executing: 'Start executing', code_review: 'Start review' };
const POLICY_LABELS = { manual: 'Manual', ask: 'Ask on entry', start: 'Start on entry' };
let runDialogContext = null;

function activeRun(taskId) { return board?.runs.find(run => run.taskId === taskId && RUN_LIVE.includes(run.status)) || null; }
function elapsed(run) {
  const end = RUN_LIVE.includes(run.status) ? Date.now() : run.endedAt || run.updatedAt;
  const seconds = Math.max(0, Math.round((end - (run.startedAt || run.createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function providerName(id) { return board?.execution?.providers?.[id]?.name || providerInfo[id]?.name || id; }

function renderRunControls(card, run) {
  const box = document.createElement('div');
  box.className = 'kanban-run';
  const active = run && RUN_LIVE.includes(run.status) ? run : null;
  if (run) {
    const badge = document.createElement('span');
    badge.className = `run-badge${active ? (run.status === 'waiting_for_input' ? ' waiting' : ' running') : ''}`;
    badge.textContent = `${run.stage === 'planning' ? 'Plan' : 'Run'} ${run.status.replaceAll('_', ' ')} · ${elapsed(run)}`;
    badge.title = [providerName(run.config?.provider), run.config?.model || 'CLI default model', run.waitingReason || run.reason].filter(Boolean).join(' · ');
    box.append(badge);
  }
  const labelled = (button, label) => { button.setAttribute('aria-label', `${label}: ${card.title}`); return button; };
  if (active) {
    box.append(labelled(detailButton('Terminal', () => window.PromptboardDock?.open(active.id), 'kanban-terminal'), 'Show terminal'));
    if (active.status === 'waiting_for_input' && active.turns > 0) {
      const planning = active.stage === 'planning';
      const button = labelled(detailButton(planning ? 'Approve plan…' : active.stage === 'code_review' ? 'Record review…' : 'Confirm stage…', () => openTaskDetails(card.id), 'primary kanban-confirm-run'), planning ? 'Review and approve the plan' : 'Review and confirm the stage');
      box.append(button);
    }
  } else if (card.column === 'testing' || card.column === 'merge') {
    box.append(labelled(detailButton(card.column === 'testing' ? 'Run tests…' : 'Merge…', () => openTaskDetails(card.id), 'primary kanban-deliver'), card.column === 'testing' ? 'Run tests' : 'Review the merge'));
  } else if (['planning', 'executing', 'code_review'].includes(card.column)) {
    const start = labelled(detailButton(`${STAGE_VERBS[card.column]}…`, () => openRunDialog(card.id, card.column), 'primary kanban-start'), STAGE_VERBS[card.column]);
    start.disabled = !board?.execution?.available || !currentProject()?.repository || !currentProject()?.targetBranch;
    if (start.disabled) start.title = !board?.execution?.available ? 'Agent terminals are not set up.' : 'Link a repository and choose a target branch first.';
    box.append(start);
  }
  box.append(labelled(detailButton('Details', () => openTaskDetails(card.id), 'kanban-details'), 'Task details'));
  return box;
}

function askToStart(card, stage) {
  if (!card) return;
  const panel = $('#ask-panel');
  // Testing and Merge open task details, where tests run and the merge preview is confirmed.
  const agent = Boolean(STAGE_VERBS[stage]);
  const verb = agent ? STAGE_VERBS[stage] : stage === 'testing' ? 'Run tests' : 'Review the merge';
  const yes = detailButton(`${verb}…`, () => { panel.hidden = true; agent ? openRunDialog(card.id, stage) : openTaskDetails(card.id); }, 'danger');
  const no = detailButton('Not now', () => { panel.hidden = true; announce(agent ? 'No agent was started.' : 'Nothing was started.'); });
  panel.replaceChildren(paragraph(`“${card.title}” is now in ${columnTitle(stage)}. ${agent ? 'Start the agent for this stage?' : `${verb} now?`} Nothing starts until you confirm.`), detailActions(yes, no));
  panel.hidden = false;
  yes.focus();
}

function fillSelect(select, values, labels = {}) { select.replaceChildren(...values.map(value => option(value, labels[value] ?? (value || 'CLI default')))); }

function renderRunFields(provider, stage, settings = {}) {
  const providers = board?.execution?.providers || {};
  const supported = Object.keys(providers).filter(id => providers[id][stage === 'executing' ? 'execution' : 'planning']?.supported);
  fillSelect($('#run-provider'), supported, Object.fromEntries(supported.map(id => [id, providers[id].notLiveVerified ? `${providers[id].name} (not verified live)` : providers[id].name])));
  $('#run-provider').value = supported.includes(provider) ? provider : supported[0] || '';
  const chosen = $('#run-provider').value;
  const efforts = { codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'], gemini: [] }[chosen] || [];
  fillSelect($('#run-effort'), ['', ...efforts]);
  $('#run-effort').value = efforts.includes(settings.effort) ? settings.effort : '';
  $('#run-effort').disabled = !efforts.length;
  const modes = stage === 'planning' || stage === 'code_review' ? ['plan'] : providers[chosen]?.permissionModes || [];
  fillSelect($('#run-permission'), modes, { plan: 'Read-only planning', acceptEdits: 'Accept edits in the worktree', default: 'Ask before every change', 'workspace-write': 'Write in the worktree, ask for more', auto_edit: 'Accept edits, ask for tools' });
  $('#run-permission').value = modes.includes(settings.permissionMode) ? settings.permissionMode : modes[0] || '';
  $('#run-permission').disabled = modes.length < 2;
  $('#run-model').value = chosen === settings.provider ? settings.model || '' : '';
  $('#run-dialog-how').textContent = providers[chosen]?.[stage === 'executing' ? 'execution' : 'planning']?.how || '';
}

function openRunDialog(taskId, stage) {
  const project = currentProject();
  const card = findTask(taskId);
  if (!card || !project) return;
  const settings = project.effectiveWorkflow?.[stage] || {};
  runDialogContext = { taskId, stage };
  $('#run-dialog-stage').textContent = `${project.name} · ${columnTitle(stage)}`.toUpperCase();
  $('#run-dialog-heading').textContent = `${STAGE_VERBS[stage]} for “${card.title}”?`;
  $('#run-dialog-summary').textContent = stage === 'planning'
    ? 'The agent inspects the repository in the task worktree and writes a plan. It cannot change files. You approve the plan before anything is implemented.'
    : stage === 'code_review' ? 'The agent reviews the committed task diff against the target branch and reports findings. It cannot change files. Completing a review is not accepting it; you decide.'
    : `The agent works in the task worktree on branch ${card.workspace?.branch || '(created when the run starts)'}. It does not touch your main checkout. You confirm the stage when you are satisfied.`;
  const approval = card.planApproval;
  $('#run-dialog-plan').textContent = stage !== 'executing' ? '' : !approval ? 'No approved plan: the agent receives the task text only.'
    : approval.contentRevision === (card.contentRevision ?? 1) ? 'The approved plan is included with the task text.' : 'The task changed after its plan was approved, so the old plan is not included.';
  const status = cardStatus(card);
  $('#run-ack-field').hidden = !status.flag;
  $('#run-ack').checked = false;
  $('#run-ack-note').textContent = status.flag ? `${status.text}. Confirm that you reviewed the prompt before an agent acts on it.` : '';
  $('#run-error').hidden = true;
  renderRunFields(settings.provider, stage, settings);
  $('#run-dialog').showModal();
  $('#run-start').focus();
}

async function submitRun(event) {
  event.preventDefault();
  const context = runDialogContext;
  const card = context && findTask(context.taskId);
  if (!card) return;
  const showError = message => { $('#run-error').textContent = message; $('#run-error').hidden = false; };
  if (!$('#run-ack-field').hidden && !$('#run-ack').checked) { showError('Confirm that you reviewed this prompt first.'); return; }
  const config = { provider: $('#run-provider').value, model: $('#run-model').value.trim(), effort: $('#run-effort').value, permissionMode: $('#run-permission').value };
  $('#run-start').disabled = true;
  try {
    const { run } = await boardCall('POST', `/api/tasks/${encodeURIComponent(card.id)}/runs`, { stage: context.stage, consent: true, config }, 120000);
    $('#run-dialog').close();
    announce(`${STAGE_VERBS[context.stage]} for “${card.title}”. The terminal is below.`);
    window.PromptboardDock?.open(run.id);
  } catch (error) { showError(error.message); }
  finally { $('#run-start').disabled = false; }
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
    section('Branch and worktree', paragraph(card.workspace ? `Branch ${card.workspace.branch} from ${card.workspace.targetBranch} at ${String(card.workspace.baseCommit).slice(0, 12)}. Worktree: ${card.workspace.path}` : 'No worktree yet. It is created when the first Planning or Executing run starts.')),
  ];
  const planRun = [...runs].reverse().find(run => run.stage === 'planning' && run.hasPlan);
  if (planRun) {
    const approved = card.planApproval?.runId === planRun.id && card.planApproval.contentRevision === (card.contentRevision ?? 1);
    const planText = pre('Loading the plan…');
    nodes.push(section(`Plan${approved ? ' (approved)' : card.planApproval?.runId === planRun.id ? ' (approval is stale: the task changed)' : ''}`, planText));
    api(`/api/runs/${encodeURIComponent(planRun.id)}/plan`, { timeoutMs: 15000 }).then(({ data }) => { planText.textContent = data.text || planRun.planExcerpt || 'The plan text is not available.'; }).catch(() => { planText.textContent = planRun.planExcerpt || 'The plan text is not available.'; });
  }
  const waiting = runs.find(run => run.status === 'waiting_for_input' && run.turns > 0);
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
    table.append(row);
  }
  nodes.push(section('Run history', runs.length ? table : paragraph('No runs yet.')));
  const delivery = document.createElement('div');
  delivery.className = 'task-delivery';
  nodes.splice(3, 0, delivery);
  $('#task-details').replaceChildren(...nodes);
  renderDelivery(card, delivery, section, pre);
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
}

function workflowSummary(project) {
  const flow = project.effectiveWorkflow || {};
  return [...['planning', 'executing'].map(stage => `${columnTitle(stage)}: ${POLICY_LABELS[flow[stage]?.policy] || 'Ask on entry'}`),
    ...(flow.merge?.policy === 'start' ? ['Merge: automatic'] : [])].join(' · ');
}

function workflowPreview(stage, settings) {
  if (stage === 'merge') return settings.policy === 'manual' ? 'Moving a card here does nothing. You review the merge preview and confirm it.'
    : settings.policy === 'ask' ? 'Moving a card here asks whether to open the merge preview. You still confirm the merge.'
    : 'Moving a card here merges it at once, but only if the code review was accepted and the tests passed for exactly the current task and target commits, the merge is a fast-forward, and the target checkout is clean. Otherwise nothing is merged and the reason is shown. Nothing is pushed.';
  const provider = providerName(settings.provider);
  const what = stage === 'planning' ? `${provider} writes a read-only plan` : stage === 'code_review' ? `${provider} reviews the committed diff read-only`
    : stage === 'testing' ? 'your configured test commands run in the task worktree' : `${provider} works in the task worktree`;
  return settings.policy === 'manual' ? `Moving a card here does nothing. You start ${columnTitle(stage)} from the card when you want.`
    : settings.policy === 'ask' ? `Moving a card here asks whether to start. If you agree, ${what}.`
    : `Moving a card here starts at once: ${what}. The run is recorded as started by this setting.`;
}

function openWorkflowDialog() {
  const project = currentProject();
  if (!project) return;
  $('#workflow-dialog-project').textContent = `${project.name} · WORKFLOW`;
  const stages = [];
  for (const stage of ['planning', 'executing', 'code_review', 'testing', 'merge']) {
    const settings = project.effectiveWorkflow?.[stage] || {};
    const box = document.createElement('fieldset');
    box.className = 'workflow-stage';
    box.dataset.stage = stage;
    const legend = document.createElement('legend'); legend.textContent = columnTitle(stage);
    const policy = document.createElement('div'); policy.className = 'segmented';
    for (const value of ['manual', 'ask', 'start']) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'radio'; input.name = `policy-${stage}`; input.value = value; input.checked = settings.policy === value;
      const span = document.createElement('span'); span.textContent = stage === 'merge' && value === 'start' ? 'Merge automatically' : POLICY_LABELS[value];
      label.append(input, span); policy.append(label);
    }
    const preview = paragraph(workflowPreview(stage, settings), 'workflow-preview');
    const children = [legend, policy];
    if (['planning', 'executing', 'code_review'].includes(stage)) {
      const grid = document.createElement('div'); grid.className = 'select-grid';
      const providers = board?.execution?.providers || {};
      const supported = Object.keys(providers).filter(id => providers[id][stage === 'executing' ? 'execution' : 'planning']?.supported);
      const providerField = document.createElement('label'); providerField.className = 'field-label'; providerField.textContent = 'Provider';
      const providerSelect = document.createElement('select'); providerSelect.dataset.field = 'provider';
      fillSelect(providerSelect, supported.length ? supported : ['claude'], Object.fromEntries(Object.entries(providers).map(([id, item]) => [id, item.name])));
      providerSelect.value = settings.provider || 'claude';
      providerField.append(providerSelect);
      const modelField = document.createElement('label'); modelField.className = 'field-label'; modelField.textContent = 'Model';
      const model = document.createElement('input'); model.type = 'text'; model.maxLength = 100; model.placeholder = 'CLI default'; model.value = settings.model || ''; model.dataset.field = 'model';
      modelField.append(model);
      grid.append(providerField, modelField);
      children.push(grid);
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
    if (stage !== 'testing' && stage !== 'merge') children.push(instructionsField);
    children.push(preview);
    box.append(...children);
    box.addEventListener('change', () => { preview.textContent = workflowPreview(stage, readWorkflowStage(box)); });
    stages.push(box);
  }
  const fixed = paragraph('To Do and Done never run agents. Merges are fast-forward only and never pushed; only a verified merge or “Reviewed: no changes required” reaches Done.', 'workflow-preview');
  $('#workflow-stages').replaceChildren(...stages, fixed);
  $('#workflow-error').hidden = true;
  $('#workflow-dialog').showModal();
}

function readWorkflowStage(box) {
  const value = field => box.querySelector(`[data-field="${field}"]`)?.value;
  const result = { policy: box.querySelector('input[type="radio"]:checked')?.value || 'ask', instructions: value('instructions') || '' };
  if (value('provider')) Object.assign(result, { provider: value('provider'), model: (value('model') || '').trim() });
  return result;
}

async function saveWorkflow(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const workflow = Object.fromEntries([...$('#workflow-stages').querySelectorAll('.workflow-stage')].map(box => [box.dataset.stage, readWorkflowStage(box)]));
  const lines = ($('#test-commands')?.value || '').split('\n').map(line => line.trim()).filter(Boolean);
  try {
    await boardCall('PATCH', `/api/projects/${encodeURIComponent(project.id)}/workflow`, { workflow, expectedRevision: project.revision });
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
  if (card.completion) {
    const done = card.completion;
    nodes.push(section('Completed', paragraph(done.kind === 'merged'
      ? `Merged${done.trigger === 'automation' ? ' automatically (project workflow setting)' : ''} into ${done.targetBranch}: ${short(done.previousTarget)} → ${short(done.mergedCommit)} (${done.method}). Nothing was pushed.`
      : 'Reviewed: no changes required. Nothing was merged.')));
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
  if (!rev.clean && rev.branchOk) {
    const diff = pre('Loading the changes…');
    const label = document.createElement('label'); label.className = 'field-label'; label.textContent = 'Commit message';
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 2000; input.value = card.title; input.id = 'commit-message';
    label.append(input);
    const box = document.createElement('div');
    box.append(detailActions(detailButton('Commit task changes…', () => confirmStep(box, `Commit all ${plural(rev.changes.length, 'change')} shown above on ${rev.branch} with your existing Git identity?`, 'Commit', () => deliveryAction(card, 'POST', 'commit', { message: input.value, confirm: true }, 'Task changes committed.')))));
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
    if (review.status === 'completed' && current) actions.push(detailButton('Accept review', () => deliveryAction(card, 'POST', 'accept-review', {}, 'Review accepted for this commit.'), 'danger'));
    if (['completed', 'accepted'].includes(review.status) && card.column === 'code_review') actions.push(detailButton('Send back to Executing', () => deliveryAction(card, 'POST', 'send-back', { expectedRevision: card.revision }, 'Sent back to Executing with the findings.')));
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
    if (commands.length && tests?.status !== 'running') {
      box.append(detailActions(detailButton('Run tests…', () => confirmStep(box, `Run ${plural(commands.length, 'command')} in the task worktree? Only exit codes decide whether tests passed.`, 'Run tests', async () => {
        if (await deliveryAction(card, 'POST', 'tests', { confirm: true }, 'Tests started.')) pollTests(card.id);
      }))));
    }
    if (tests?.status === 'running') pollTests(card.id);
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
  // No-change completion and cleanup.
  if (rev.clean && !rev.ahead && !['todo', 'done'].includes(card.column)) {
    const box = section('Finish without changes', paragraph('The task branch has no changes. If none are needed, complete the task without a merge.'));
    box.append(detailActions(detailButton('Reviewed: no changes required…', () => confirmStep(box, 'Complete this task as “no changes required”? It is not described as merged.', 'Complete with no changes', () => deliveryAction(card, 'POST', 'complete-no-changes', { confirm: true }, 'Completed with no changes required.')))));
    nodes.push(box);
  }
  if (card.column === 'done') {
    const box = section('Worktree', paragraph(`The worktree at ${card.workspace.path} is no longer needed. Removing it keeps the branch ${card.workspace.branch}. A worktree with uncommitted changes is never removed.`));
    box.append(detailActions(detailButton('Remove worktree…', () => confirmStep(box, 'Remove this task worktree? The branch stays.', 'Remove worktree', () => deliveryAction(card, 'DELETE', 'worktree', undefined, 'Worktree removed; the branch was kept.')))));
    nodes.push(box);
  }
  container.replaceChildren(...nodes);
}

function pollTests(taskId) {
  clearTimeout(pollTests.timer);
  pollTests.timer = setTimeout(async () => {
    await loadBoard();
    const card = findTask(taskId);
    if ($('#task-dialog').open && card) openTaskDetails(taskId);
  }, 1500);
}

// ---- Repository link and target branch ----

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
      pending.workflow && `workflow settings${automatic.length ? ` (automatic runs in ${automatic.join(' and ')})` : ''}`, pending.testCommands?.length && `${plural(pending.testCommands.length, 'test command')}`].filter(Boolean);
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

async function linkRepository(path) {
  const project = currentProject();
  if (!project) return;
  repoMessage('');
  $('#repo-link').disabled = true;
  try {
    const result = await boardCall('POST', `/api/projects/${encodeURIComponent(project.id)}/repository`, { path, expectedRevision: project.revision }, 60000);
    if (result.repository) repositories.set(project.id, result.repository); else repositories.delete(project.id);
    renderRepository(currentProject());
    announce(path === null ? `Unlinked “${project.name}”.` : `Linked “${project.name}” to ${result.repository.root}. Choose the target branch next.`);
  } catch (error) { repoMessage(error.message); }
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
    const { response, data } = await api('/api/board/export', { timeoutMs: 60000 });
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
$('#skip-link').addEventListener('click', event => { event.preventDefault(); ($('#kanban-view').hidden ? $('#prompt-input') : $('#kanban-view')).focus(); });
$('#kanban-button').addEventListener('click', openAddToKanban);
$('#add-form').addEventListener('submit', addToKanban);
$('#add-project').addEventListener('change', () => { $('#add-project-name-field').hidden = Boolean($('#add-project').value); });
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#add-dialog-close').addEventListener('click', () => $('#add-dialog').close());
$('#project-select').addEventListener('change', () => {
  savePref(SELECTED_PROJECT_KEY, $('#project-select').value);
  closeProjectForm();
  showProjectDetail();
  renderBoard();
  announce(`Showing project “${currentProject()?.name}”.`);
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
$('#workflow-form').addEventListener('submit', saveWorkflow);
$('#workflow-cancel').addEventListener('click', () => $('#workflow-dialog').close());
$('#workflow-dialog-close').addEventListener('click', () => $('#workflow-dialog').close());
$('#run-form').addEventListener('submit', submitRun);
$('#run-provider').addEventListener('change', () => renderRunFields($('#run-provider').value, runDialogContext?.stage, {}));
$('#run-cancel').addEventListener('click', () => $('#run-dialog').close());
$('#run-dialog-close').addEventListener('click', () => $('#run-dialog').close());
$('#task-dialog-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog-done').addEventListener('click', () => $('#task-dialog').close());
$('#import-confirm').addEventListener('click', () => confirmImported(true));
$('#import-dismiss').addEventListener('click', () => confirmImported(false));
$('#card-new').addEventListener('click', () => openCard());
$('#card-form').addEventListener('submit', saveCard);
$('#card-cancel').addEventListener('click', () => $('#card-dialog').close());
$('#card-dialog-close').addEventListener('click', () => $('#card-dialog').close());
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
$('#load-example').addEventListener('click', () => {
  if (running) return;
  currentId = null;
  clearOutput();
  $('#prompt-input').value = 'Build a small FastAPI service that accepts a job URL and returns a structured job description. Use Python 3.12 and Pydantic. Include the title, company, location, work mode, salary, and required skills. Do not invent missing information. Add a health endpoint and meaningful tests. Keep the setup simple enough to run locally with one command.';
  $('#task').value = 'build';
  $('#terminology').value = 'FastAPI, Python 3.12, Pydantic';
  updateCount();
  renderHistory();
  $('#prompt-input').focus();
  announce('Example input loaded. Select a CLI and generate your own result.');
});
$('#copy-button').addEventListener('click', async () => {
  if (!currentResult) return;
  try {
    await navigator.clipboard.writeText(currentResult.prompt);
    $('#copy-label').textContent = 'Copied!';
    $('#copy-cheer').hidden = false;
    announce('Prompt copied to your clipboard.');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('#copy-label').textContent = 'Copy prompt'; $('#copy-cheer').hidden = true; }, 1800);
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
showPage();
loadProviders();
$('#settings-toggle').addEventListener('click', () => setSettingsCollapsed(!$('#settings-body').hidden));
$('#project-toggle').addEventListener('click', () => setProjectCollapsed(!$('#project-body').hidden));

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
try { if (localStorage.getItem(PROJECT_PANEL_KEY) === 'collapsed') setProjectCollapsed(true, false); } catch {}
// A required field inside a collapsed card would block submit without a visible message. Reopen it.
$('#settings-body').addEventListener('invalid', () => setSettingsCollapsed(false, false), true);
