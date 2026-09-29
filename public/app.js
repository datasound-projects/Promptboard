'use strict';

const $ = (selector) => document.querySelector(selector);
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const THEME_KEY = 'ste-prompt-engineer.theme'; // Also read by prefs.js before first paint.
const SIDEBAR_KEY = 'ste-prompt-engineer.sidebar';
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
      paragraph('This app saves your last 40 finished prompts and your Kanban board in this browser’s local storage. You can delete prompts in the sidebar and projects or cards on the Kanban page. Clearing this site’s browser data also removes them.'),
      paragraph('The Kanban page only stores and copies text. It never sends cards to a CLI or model.'),
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
  document.title = kanban ? 'Kanban · AI Prompt Engineer' : 'AI Prompt Engineer · STE';
  if (kanban) renderBoard();
  setSidebar(false);
  window.scrollTo(0, 0);
}
function showPromptPage() { if (location.hash === '#/kanban') location.hash = '#/'; }

// Kanban: projects, each with one "To do" column of task cards for a coding agent.
// A card stores its own copy of the prompt. Nothing here runs a CLI or a model.
const KANBAN_KEY = 'ste-prompt-engineer.kanban.v1';
const PROJECT_LIMIT = 200;
const CARD_LIMIT = 1000;
const IMPORT_LIMIT_BYTES = 20 * 1024 * 1024;
let board = readBoard();
let editingCardId = null;
let projectFormMode = 'new';
let dragId = null;

function emptyBoard() { return { version: 1, selectedProjectId: null, projects: [] }; }

function readBoard() {
  let raw = null;
  try { raw = localStorage.getItem(KANBAN_KEY); } catch { return emptyBoard(); }
  if (raw === null) return emptyBoard();
  try { return parseBoard(JSON.parse(raw)); } catch {
    // Keep the unreadable value before any later save replaces it.
    let kept = false;
    try { localStorage.setItem(`${KANBAN_KEY}.unreadable`, raw); kept = true; } catch {}
    $('#kanban-load-warning').textContent = kept
      ? `The saved Kanban board could not be read, so the board starts empty. The unreadable data is kept in this browser under “${KANBAN_KEY}.unreadable”.`
      : 'The saved Kanban board could not be read, so the board starts empty. The unreadable data could not be kept and is replaced when you change the board.';
    $('#kanban-load-warning').hidden = false;
    return emptyBoard();
  }
}

function requiredText(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new Error(`${label} needs 1 to ${max} characters.`);
  return text;
}

// One strict check for stored boards and imported backups. Prompt text is kept exactly as it is.
function parseBoard(data) {
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.projects)) throw new Error('The data is not a version 1 Kanban board.');
  if (data.projects.length > PROJECT_LIMIT) throw new Error(`A board can have at most ${PROJECT_LIMIT} projects.`);
  const ids = new Set();
  const uniqueId = (value, label) => {
    if (typeof value !== 'string' || !value || value.length > 100 || ids.has(value)) throw new Error(`${label} needs a unique ID.`);
    ids.add(value);
    return value;
  };
  const time = value => Number.isFinite(value) ? value : Date.now();
  const projects = data.projects.map((project, index) => {
    const label = `Project ${index + 1}`;
    if (!project || typeof project !== 'object') throw new Error(`${label} is not valid.`);
    if (!Array.isArray(project.cards) || project.cards.length > CARD_LIMIT) throw new Error(`${label} needs a card list with at most ${CARD_LIMIT} cards.`);
    return { id: uniqueId(project.id, label), name: requiredText(project.name, 80, `${label} name`), createdAt: time(project.createdAt),
      cards: project.cards.map((card, cardIndex) => {
        const cardLabel = `${label}, card ${cardIndex + 1}`;
        if (!card || typeof card !== 'object') throw new Error(`${cardLabel} is not valid.`);
        if (typeof card.prompt !== 'string' || !card.prompt.trim() || card.prompt.length > MAX_PROMPT_BYTES) throw new Error(`${cardLabel} needs a prompt of 1 to ${MAX_PROMPT_BYTES.toLocaleString()} characters.`);
        return { id: uniqueId(card.id, cardLabel), title: requiredText(card.title, 120, `${cardLabel} title`), prompt: card.prompt,
          createdAt: time(card.createdAt), updatedAt: time(card.updatedAt ?? card.createdAt), checksOutdated: card.checksOutdated === true, source: normalizeSource(card.source) };
      }) };
  });
  const selectedProjectId = projects.some(project => project.id === data.selectedProjectId) ? data.selectedProjectId : projects[0]?.id ?? null;
  return { version: 1, selectedProjectId, projects };
}

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
function boardCounts(value) { return `${plural(value.projects.length, 'project')}, ${plural(value.projects.reduce((sum, project) => sum + project.cards.length, 0), 'card')}`; }
function currentProject() { return board.projects.find(project => project.id === board.selectedProjectId) || null; }

function persistBoard() {
  let saved = true;
  try { localStorage.setItem(KANBAN_KEY, JSON.stringify(board)); } catch { saved = false; }
  for (const warning of document.querySelectorAll('.board-warning')) warning.hidden = saved;
  return saved;
}

function commitBoard(message) {
  const saved = persistBoard();
  renderBoard();
  announce(saved ? message : `${message} Board changes were not saved in this browser.`);
  return saved;
}

function renderBoard() {
  const project = currentProject();
  const cards = project?.cards || [];
  $('#project-select').replaceChildren(...board.projects.map(item => option(item.id, item.name)));
  if (!project) $('#project-select').append(option('', 'No projects yet'));
  $('#project-select').value = project?.id || '';
  $('#project-select').disabled = !project;
  for (const id of ['#project-rename', '#project-delete', '#card-new']) $(id).disabled = !project;
  $('#todo-count').textContent = String(cards.length).padStart(2, '0');
  $('#board-empty').hidden = cards.length > 0;
  $('#board-empty-text').textContent = project ? 'No tasks yet.' : 'Create a project to start planning.';
  $('#board-empty-note').textContent = project ? 'Choose New card, or add a generated prompt from the Compose page.' : 'Each project gets its own board with one To do column.';
  $('#empty-prompt-link').hidden = !project;
  $('#card-list').replaceChildren(...cards.map((card, index) => renderCard(card, index, cards.length)));
}

function renderCard(card, index, count) {
  const status = cardStatus(card);
  const item = document.createElement('li');
  item.className = `kanban-card${status.flag ? ' needs-review' : ''}`;
  item.dataset.id = card.id;
  item.draggable = true;
  const badge = document.createElement('span');
  badge.className = 'kanban-status';
  badge.textContent = status.text;
  const heading = document.createElement('h3');
  heading.append(detailButton(card.title, () => openCard(card.id), 'kanban-open'));
  const labelled = (button, label) => { button.setAttribute('aria-label', label); return button; };
  const up = labelled(detailButton('↑', () => moveCard(card.id, -1), 'kanban-move kanban-move-up'), `Move up: ${card.title}`);
  const down = labelled(detailButton('↓', () => moveCard(card.id, 1), 'kanban-move kanban-move-down'), `Move down: ${card.title}`);
  up.disabled = index === 0;
  down.disabled = index === count - 1;
  const copy = labelled(detailButton('Copy prompt', () => copyCard(card, copy), 'kanban-copy'), `Copy prompt: ${card.title}`);
  const actions = document.createElement('div');
  actions.className = 'kanban-actions';
  actions.append(up, down, copy,
    labelled(detailButton('Duplicate', () => duplicateCard(card.id), 'kanban-duplicate'), `Duplicate: ${card.title}`),
    labelled(detailButton('Delete', () => confirmCardDelete(item, card), 'kanban-delete'), `Delete: ${card.title}`));
  item.append(badge, heading, paragraph(card.prompt.slice(0, 400).replace(/\s+/g, ' ').trim(), 'kanban-preview'),
    paragraph(card.source ? sourceSummary(card.source) : 'Written by you', 'kanban-meta'), actions);
  // Pointer drag-and-drop. The ↑ and ↓ buttons are the keyboard equivalent.
  item.addEventListener('dragstart', event => {
    dragId = card.id;
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.title); }
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    dragId = null;
    for (const element of document.querySelectorAll('.kanban-card.dragging, .kanban-card.drop-target')) element.classList.remove('dragging', 'drop-target');
  });
  item.addEventListener('dragover', event => { if (!dragId || dragId === card.id) return; event.preventDefault(); item.classList.add('drop-target'); });
  item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
  item.addEventListener('drop', event => { event.preventDefault(); if (dragId && dragId !== card.id) placeCard(dragId, index); dragId = null; });
  return item;
}

function cardElement(id) { return Array.from($('#card-list').children).find(item => item.dataset.id === id); }

function placeCard(id, target) {
  const cards = currentProject()?.cards || [];
  const from = cards.findIndex(card => card.id === id);
  if (from < 0 || target < 0 || target >= cards.length || target === from) return false;
  const [card] = cards.splice(from, 1);
  cards.splice(target, 0, card);
  commitBoard(`Moved “${card.title}” to position ${target + 1} of ${cards.length}.`);
  return true;
}

function moveCard(id, step) {
  const cards = currentProject()?.cards || [];
  if (!placeCard(id, cards.findIndex(card => card.id === id) + step)) return;
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

function duplicateCard(id) {
  const cards = currentProject().cards;
  const index = cards.findIndex(card => card.id === id);
  if (index < 0) return;
  if (cards.length >= CARD_LIMIT) { announce(`A project can have at most ${CARD_LIMIT} cards.`); return; }
  const card = cards[index];
  const now = Date.now();
  const copy = { ...card, id: crypto.randomUUID(), title: `${card.title.slice(0, 113)} (copy)`, createdAt: now, updatedAt: now, source: card.source && { ...card.source, reportedModels: [...card.source.reportedModels] } };
  cards.splice(index + 1, 0, copy);
  commitBoard(`Duplicated “${card.title}”.`);
  cardElement(copy.id)?.querySelector('.kanban-open').focus();
}

function confirmCardDelete(item, card) {
  const keep = detailButton('Keep card', () => { renderBoard(); cardElement(card.id)?.querySelector('.kanban-delete').focus(); });
  const confirm = document.createElement('div');
  confirm.className = 'connection-detail kanban-confirm';
  confirm.append(paragraph(`Delete “${card.title}”? This cannot be undone.`), detailActions(detailButton('Delete card', () => deleteCard(card.id), 'danger'), keep));
  item.querySelector('.kanban-actions').replaceWith(confirm);
  keep.focus();
}

function deleteCard(id) {
  const cards = currentProject().cards;
  const index = cards.findIndex(card => card.id === id);
  if (index < 0) return;
  const [card] = cards.splice(index, 1);
  commitBoard(`Deleted “${card.title}”.`);
  (cardElement(cards[Math.min(index, cards.length - 1)]?.id)?.querySelector('.kanban-open') || $('#card-new')).focus();
}

function openCard(id = null) {
  const project = currentProject();
  if (!project) return;
  const card = id ? project.cards.find(item => item.id === id) : null;
  editingCardId = card?.id || null;
  $('#card-dialog-project').textContent = `${project.name} · To do`;
  $('#card-dialog-heading').textContent = card ? 'Edit card' : 'New card';
  $('#card-title').value = card?.title || '';
  $('#card-prompt').value = card?.prompt || '';
  const status = card && cardStatus(card);
  $('#card-status').hidden = !card;
  $('#card-status').textContent = status?.text || '';
  $('#card-status').classList.toggle('needs-review', Boolean(status?.flag));
  $('#card-note').textContent = !card?.source ? 'Write the task as your coding agent should receive it. Copy prompt copies this text exactly.'
    : card.checksOutdated ? 'This prompt was edited. The checks from generation apply to the original text only. Your prompt history is unchanged.'
    : 'Imported from Prompt Engineer. Saving changes marks the previous checks as outdated. Your prompt history is unchanged.';
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

function saveCard(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const card = editingCardId ? project.cards.find(item => item.id === editingCardId) : null;
  const title = $('#card-title').value.trim();
  const typed = $('#card-prompt').value;
  const error = !title ? 'Enter a short title.' : title.length > 120 ? 'Use a title of at most 120 characters.'
    : !typed.trim() ? 'Enter the prompt for this task.' : typed.length > MAX_PROMPT_BYTES ? 'The prompt exceeds the 2 MiB limit.'
    : !card && project.cards.length >= CARD_LIMIT ? `A project can have at most ${CARD_LIMIT} cards.` : '';
  if (error) { $('#card-error').textContent = error; $('#card-error').hidden = false; return; }
  const now = Date.now();
  let saved = card;
  let message;
  if (card) {
    // A textarea turns \r\n into \n. Keep the stored text when nothing else changed.
    const prompt = typed === card.prompt.replace(/\r\n?/g, '\n') ? card.prompt : typed;
    if (title === card.title && prompt === card.prompt) message = 'No changes to save.';
    else {
      Object.assign(card, { title, prompt, updatedAt: now, checksOutdated: Boolean(card.source) });
      message = card.source ? `Saved “${title}”. The previous checks are now marked as outdated.` : `Saved “${title}”.`;
    }
  } else {
    saved = { id: crypto.randomUUID(), title, prompt: typed, createdAt: now, updatedAt: now, checksOutdated: false, source: null };
    project.cards.push(saved);
    message = `Added “${title}” to To do.`;
  }
  $('#card-dialog').close();
  commitBoard(message);
  cardElement(saved.id)?.querySelector('.kanban-open').focus();
}

function projectNameError(name, exceptId = null) {
  if (!name) return 'Enter a project name.';
  if (name.length > 80) return 'Use a project name of at most 80 characters.';
  if (board.projects.some(project => project.id !== exceptId && project.name.toLowerCase() === name.toLowerCase())) return 'A project with this name already exists.';
  return '';
}

function createProject(name) {
  const project = { id: crypto.randomUUID(), name, createdAt: Date.now(), cards: [] };
  board.projects.push(project);
  board.selectedProjectId = project.id;
  return project;
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
  $('#project-name').focus();
}

function closeProjectForm() { $('#project-form').hidden = true; $('#project-error').hidden = true; }

function saveProject(event) {
  event.preventDefault();
  const name = $('#project-name').value.trim();
  const project = projectFormMode === 'rename' ? currentProject() : null;
  const error = !project && board.projects.length >= PROJECT_LIMIT ? `A board can have at most ${PROJECT_LIMIT} projects.` : projectNameError(name, project?.id);
  if (error) { $('#project-error').textContent = error; $('#project-error').hidden = false; $('#project-name').focus(); return; }
  closeProjectForm();
  if (project) {
    const previous = project.name;
    project.name = name;
    commitBoard(`Renamed “${previous}” to “${name}”.`);
  } else {
    createProject(name);
    commitBoard(`Created project “${name}”.`);
  }
  $('#project-select').focus();
}

function confirmProjectDelete() {
  const project = currentProject();
  if (!project) return;
  closeProjectForm();
  const keep = detailButton('Keep project', () => { showProjectDetail(); $('#project-delete').focus(); });
  showProjectDetail(
    paragraph(`Delete “${project.name}” and its ${plural(project.cards.length, 'card')}? This cannot be undone. Export a backup first if you want to keep them.`),
    detailActions(detailButton('Delete project', () => deleteProject(project.id), 'danger'), keep),
  );
  keep.focus();
}

function deleteProject(id) {
  const project = board.projects.find(item => item.id === id);
  if (!project) return;
  board.projects = board.projects.filter(item => item.id !== id);
  if (board.selectedProjectId === id) board.selectedProjectId = board.projects[0]?.id ?? null;
  showProjectDetail();
  commitBoard(`Deleted project “${project.name}”.`);
  $(board.projects.length ? '#project-select' : '#project-new').focus();
}

function exportBoard() {
  const backup = { application: 'AI Prompt Engineer', kind: 'kanban-backup', version: 1, exportedAt: new Date().toISOString(), selectedProjectId: board.selectedProjectId, projects: board.projects };
  downloadFile(`${JSON.stringify(backup, null, 2)}\n`, 'application/json;charset=utf-8', `ste-kanban-backup-${new Date().toISOString().slice(0, 10)}.json`);
  announce(`Board backup exported: ${boardCounts(board)}.`);
}

async function importBoard() {
  const file = $('#import-file').files?.[0];
  $('#import-file').value = '';
  if (!file) return;
  closeProjectForm();
  let imported;
  try {
    if (file.size > IMPORT_LIMIT_BYTES) throw new Error('The file is larger than 20 MB.');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('The file is not valid JSON.'); }
    if (data?.kind !== 'kanban-backup') throw new Error('The file is not a Kanban backup from AI Prompt Engineer.');
    imported = parseBoard(data);
  } catch (error) {
    showProjectDetail(paragraph(`Import failed. Your board is unchanged. ${error.message}`, 'kanban-error'));
    announce(`Import failed. Your board is unchanged. ${error.message}`);
    return;
  }
  const replace = () => {
    board = imported;
    showProjectDetail(paragraph(`Backup imported: ${boardCounts(imported)}.`));
    commitBoard(`Backup imported: ${boardCounts(imported)}.`);
  };
  if (!board.projects.length) { replace(); return; }
  const keep = detailButton('Keep current board', () => { showProjectDetail(); announce('Import canceled. Your board is unchanged.'); });
  showProjectDetail(
    paragraph(`Replace the current board (${boardCounts(board)}) with this backup (${boardCounts(imported)})? The current board is removed. Export it first if you want to keep it.`),
    detailActions(detailButton('Replace board', replace, 'danger'), keep),
  );
  keep.focus();
}

function openAddToKanban() {
  if (!currentResult || running) return;
  const source = snapshotSource(currentResult);
  $('#add-project').replaceChildren(...board.projects.map(project => option(project.id, project.name)), option('', 'New project…'));
  $('#add-project').value = currentProject()?.id || '';
  $('#add-project-name').value = '';
  $('#add-project-name-field').hidden = Boolean($('#add-project').value);
  $('#add-title').value = currentResult.input.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Generated prompt';
  $('#add-preview').textContent = currentResult.prompt;
  $('#add-note').textContent = `The exact prompt below is copied into the card (${currentResult.prompt.length.toLocaleString()} characters). Later card edits do not change your prompt history. Source: ${sourceSummary(source)} · ${cardStatus({ source, checksOutdated: false }).text}.`;
  $('#add-error').hidden = true;
  $('#add-dialog').showModal();
  $(board.projects.length ? '#add-title' : '#add-project-name').focus();
}

function addToKanban(event) {
  event.preventDefault();
  const result = currentResult;
  const title = $('#add-title').value.trim();
  const name = $('#add-project-name').value.trim();
  let project = board.projects.find(item => item.id === $('#add-project').value);
  const error = !result || !result.prompt.trim() ? 'There is no prompt to add.' : !title ? 'Enter a short card title.' : title.length > 120 ? 'Use a title of at most 120 characters.'
    : project ? (project.cards.length >= CARD_LIMIT ? `This project already has ${CARD_LIMIT} cards.` : '')
    : board.projects.length >= PROJECT_LIMIT ? `A board can have at most ${PROJECT_LIMIT} projects.` : projectNameError(name);
  if (error) { $('#add-error').textContent = error; $('#add-error').hidden = false; return; }
  project ||= createProject(name);
  board.selectedProjectId = project.id;
  const now = Date.now();
  project.cards.push({ id: crypto.randomUUID(), title, prompt: result.prompt, createdAt: now, updatedAt: now, checksOutdated: false, source: snapshotSource(result) });
  $('#add-dialog').close();
  const saved = persistBoard();
  renderBoard();
  announce(saved ? `Added “${title}” to ${project.name}.` : `Added “${title}” to ${project.name} for this session only. Board changes were not saved in this browser.`);
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
  board.selectedProjectId = $('#project-select').value;
  closeProjectForm();
  showProjectDetail();
  commitBoard(`Showing project “${currentProject()?.name}”.`);
});
$('#project-new').addEventListener('click', () => openProjectForm('new'));
$('#project-rename').addEventListener('click', () => openProjectForm('rename'));
$('#project-delete').addEventListener('click', confirmProjectDelete);
$('#project-form').addEventListener('submit', saveProject);
$('#project-cancel').addEventListener('click', closeProjectForm);
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
  const report = { application: 'AI Prompt Engineer', request: { input, provider, model, effort, language, quality, detail, task, options, terminology }, prompt, reportedModels, verification, lint };
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
