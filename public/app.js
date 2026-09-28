'use strict';

const $ = (selector) => document.querySelector(selector);
const HISTORY_KEY = 'ste-prompt-engineer.history.v1';
const HISTORY_LIMIT = 40;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const KNOWN_PROVIDERS = ['codex', 'claude', 'gemini', 'agy'];
const KNOWN_DETAILS = ['super-short', 'concise', 'detailed', 'extremely-detailed'];
const KNOWN_TASKS = ['build', 'debug', 'refactor', 'review', 'architecture', 'agent-workflow', 'research'];
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

function safeText(value, max = MAX_PROMPT_BYTES) { return typeof value === 'string' ? value.slice(0, max) : ''; }

function readHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.prompt === 'string' && typeof entry.input === 'string' && entry.input.length <= 24000 && entry.prompt.length <= MAX_PROMPT_BYTES)
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
  $('#history-empty p').textContent = query ? 'No matching prompts.' : 'A little less chaos.\nA place for every prompt.';
  $('#history-empty p').style.whiteSpace = 'pre-line';
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
  $('#character-count').textContent = `${$('#prompt-input').value.length.toLocaleString()} / 24,000`;
}

function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#sidebar-scrim').hidden = !open;
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
}

function selectedProvider() { return providers.find((provider) => provider.id === $('#provider').value); }

function updateProviderState() {
  const provider = selectedProvider();
  const available = Boolean(provider?.available);
  const availableCount = providers.filter((item) => item.available).length;
  $('#generate-button').disabled = running || modelsLoading || invalidEffort || !available || !token;
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
  $('#refresh-models').disabled = running || modelsLoading || !token;
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
    const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}${refresh ? '&refresh=1' : ''}`, { cache: 'no-store', headers: { 'X-STE-Token': token } });
    if (!response.ok) throw new Error('Cannot read model options. Check your CLI, then refresh.');
    const data = await response.json();
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
  $('#generate-label').textContent = value ? 'Writing and checking…' : 'Okay , Lets Goooo!';
  $('#new-prompt').disabled = value;
  $('#load-example').disabled = value;
  for (const input of $('#prompt-form').querySelectorAll('input,select,textarea')) input.disabled = value;
  $('#copy-button').disabled = value || !currentResult;
  $('#export-button').disabled = value || !currentResult;
  $('#report-button').disabled = value || !currentResult?.verification;
  $('#refresh-models').disabled = value || modelsLoading;
  $('#model').disabled = value || modelsLoading;
  updateEffort($('#effort').value);
  renderHistory();
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
    { en: 'English', de: 'Deutsch', pl: 'Polski' }[result.language || 'en'], result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '', 'Human review required'];
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function generate(event) {
  event.preventDefault();
  if (running || modelsLoading || invalidEffort || !token || !selectedProvider()?.available) return;
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
  controller = new AbortController();
  setRunning(true);
  announce('Your CLI is engineering the prompt.');
  try {
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-STE-Token': token },
      body: JSON.stringify(request), signal: controller.signal,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The CLI could not complete this prompt.');
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
    $('#output-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    if (previousResult) showResult(previousResult);
    else { currentResult = null; $('#output-empty').hidden = false; }
    if (error.name === 'AbortError') announce('Generation canceled.');
    else {
      $('#generation-error').textContent = error.message || 'Generation failed. Please try again.';
      $('#generation-error').hidden = false;
      if (/token|session|403/i.test(error.message || '')) await loadProviders();
    }
  } finally {
    controller = null;
    setRunning(false);
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
      paragraph('This app saves your last 40 finished prompts in this browser’s local storage. You can delete them in the sidebar. Clearing this site’s browser data also removes them.'),
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

$('#prompt-form').addEventListener('submit', generate);
$('#prompt-input').addEventListener('input', updateCount);
$('#provider').addEventListener('change', () => { updateProviderState(); loadModels(); });
$('#model').addEventListener('change', () => updateEffort());
$('#custom-model').addEventListener('input', () => updateEffort($('#effort').value));
$('#effort').addEventListener('change', () => updateEffort($('#effort').value));
$('#refresh-models').addEventListener('click', () => loadModels({ model: chosenModel(), effort: $('#effort').value, refresh: true }));
for (const button of document.querySelectorAll('input[name="language"]')) button.addEventListener('change', updateLanguage);
for (const button of document.querySelectorAll('input[name="quality"]')) button.addEventListener('change', updateQuality);
$('#history-search').addEventListener('input', renderHistory);
$('#new-prompt').addEventListener('click', newPrompt);
$('#menu-toggle').addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('open')));
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
$('#cancel-button').addEventListener('click', () => controller?.abort());
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
  if (event.key.toLowerCase() === 'n' && !isEditing && !event.metaKey && !event.ctrlKey && !event.altKey && !$('#help-dialog').open) {
    event.preventDefault();
    newPrompt();
  }
  if (event.key === 'Escape') setSidebar(false);
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && isEditing && !running && !$('#generate-button').disabled) {
    event.preventDefault();
    $('#prompt-form').requestSubmit();
  }
});

renderHistory();
updateCount();
updateQuality();
loadProviders();
