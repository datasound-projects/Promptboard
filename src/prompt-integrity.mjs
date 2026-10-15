/**
 * Prompt integrity for Compose Batch: what an engineered prompt kept from its Origin task. Deterministic
 * checks (exact literals, task keys, rejected technologies, the requirement trace) run here without a
 * model; the model review from the generation pipeline is read as evidence, never as a score. Findings
 * are blocking (approval is refused), warning (a person must read and approve this task individually)
 * or info. Nothing here calls a model, the network or the file system.
 */
import { sourceUnits } from './pipeline.mjs';
import { verifyPrompt } from './verification.mjs';

const STOP = new Set(('the and for with that this from into when then than are was were has have not but all any can each its use '
  + 'der die das und mit für ist sind nicht ein eine einer oder auf von den dem des wenn dann als '
  + 'oraz dla jest nie lub się jak gdy czy przy jego jej').split(' '));
const tokens = text => [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length >= 3 && !STOP.has(word)))];
const CHECK_HEADING = /accept|check|done|verif|test|criteri|abnahme|prüf|kryter|akcept|sprawdz|weryfik/i;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escape(name)}($|[^\\p{L}\\p{N}_-])`, 'iu').test(text);

/**
 * The text Compose engineers for one Origin task: its key and title, what to do, and one line per
 * "done when" check, so each acceptance criterion is its own requirement unit in the review.
 */
export function taskInput({ key, title, description = '', acceptanceCriteria = '' }) {
  const done = String(acceptanceCriteria).split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim()).filter(Boolean);
  return [`${key} ${String(title).trim() || 'Untitled task'}`.trim(), String(description).trim(), ...done.map(line => `Done when: ${line}`)].filter(Boolean).join('\n');
}

/** Prompt lines with the Markdown section each one belongs to. */
function promptLines(prompt) {
  let section = 'Introduction', fence = false;
  const rows = [];
  for (const raw of prompt.split(/\r?\n/)) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(raw)) { fence = !fence; continue; }
    const heading = !fence && raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) { section = heading[1]; continue; }
    if (raw.trim()) rows.push({ section, text: raw.trim(), check: CHECK_HEADING.test(section) });
  }
  return rows;
}
function best(unitTokens, rows) {
  let found = null;
  for (const row of rows) {
    const words = new Set(tokens(row.text));
    const score = unitTokens.length ? unitTokens.filter(word => words.has(word)).length / unitTokens.length : 0;
    if (!found || score > found.score) found = { score, row };
  }
  return found && found.score > 0 ? found : null;
}

/**
 * Origin requirement → prompt section → acceptance check, for every requirement unit of the task. The
 * match is lexical (shared words), so it locates; the model review decides coverage when it ran.
 */
export function traceRequirements(input, prompt, review = null) {
  const rows = promptLines(prompt), checks = rows.filter(row => row.check);
  const reviewed = new Map((review?.requirements || []).map(row => [row.id, row.status]));
  return sourceUnits(input).map(unit => {
    const words = tokens(unit.text.replace(/^Done when:\s*/, '')), where = best(words, rows), check = best(words, checks.length ? checks : []);
    return { id: unit.id, text: unit.text, kind: /^Done when:/.test(unit.text) ? 'done-when' : 'task',
      section: where?.row.section || '', excerpt: where?.row.text.slice(0, 240) || '', score: Math.round((where?.score || 0) * 100) / 100,
      check: check && check.score >= 0.34 ? check.row.text.slice(0, 240) : '', review: reviewed.get(unit.id) || (review?.status === 'pass' || review?.status === 'issues' || review?.status === 'uncertain' ? 'covered' : 'not reviewed') };
  });
}

/**
 * Findings for one prompt version. `source` is the immutable task snapshot taken when the task entered the
 * batch; `verification` holds the exact-literal checks for this text and the latest model review.
 * `reviewStale` marks a prompt a person changed after that review: the review no longer describes it, and
 * a review that found problems keeps blocking until the prompt is checked again.
 */
export function assessPrompt({ source, prompt, verification = null, language = 'en', reviewStale = false }) {
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message: String(message).slice(0, 600), ...extra });
  if (typeof prompt !== 'string' || !prompt.trim()) {
    add('blocking', 'empty', 'The prompt is empty.');
    return { status: 'blocked', findings, trace: [] };
  }
  const automatic = verification?.automatic || verifyPrompt(source.input, prompt, language);
  for (const issue of automatic.issues || []) add('blocking', 'literal', issue.message, issue.excerpt ? { excerpt: String(issue.excerpt).slice(0, 200) } : {});
  const review = verification?.review || { status: 'skipped', requirements: [], criteria: [], issues: [] };
  const confirmed = review.requirements.filter(row => row.status === 'missing' || row.status === 'changed');
  if (!reviewStale) {
    for (const row of confirmed) add('blocking', `requirement-${row.status}`, `${row.id} is ${row.status === 'missing' ? 'missing from' : 'changed in'} the prompt: ${row.note}`, { requirement: row.id, excerpt: String(row.sourceQuote || '').slice(0, 200) });
    if (review.status === 'issues') for (const issue of review.issues) add('blocking', `review-${issue.category}`, issue.message, issue.promptQuote ? { excerpt: String(issue.promptQuote).slice(0, 200) } : {});
    for (const row of review.requirements.filter(entry => entry.status === 'uncertain')) add('warning', 'requirement-uncertain', `The review could not confirm ${row.id}: ${row.note}`, { requirement: row.id });
    for (const row of review.criteria.filter(entry => entry.status === 'uncertain')) add('warning', 'criterion-uncertain', `The review could not decide the “${row.criterion}” check.`);
    if (review.status === 'unavailable') add('warning', 'review-unavailable', review.issues[0]?.message || 'The model review did not complete. Read the prompt against the task.');
    if (review.status === 'skipped') add('warning', 'review-skipped', 'Fast mode: no model review ran. Read the prompt against the task before you approve it.');
    if (verification?.repairFailed) add('warning', 'repair-failed', 'The automatic revision failed. This is the first draft with its findings.');
    if (verification?.repaired) add('info', 'repaired', 'The prompt was revised once automatically after the review.');
  } else if (review.status === 'issues' || confirmed.length) {
    add('blocking', 'recheck-required', 'The last model review found problems and the prompt was edited since. Check it again before approval.');
  } else {
    add('warning', 'edit-unreviewed', 'Your edit has not been reviewed by the model. Check it again, or approve after reading it.');
  }
  const trace = traceRequirements(source.input, prompt, reviewStale ? null : review);
  // Words shared with the check. A paraphrase the review confirmed needs fewer of them; none at all is always reported.
  for (const row of trace.filter(entry => entry.kind === 'done-when' && entry.score < (entry.review === 'covered' ? 0.25 : 0.5))) {
    add(language === 'en' ? 'warning' : 'info', 'acceptance-untraced', `The acceptance check “${row.text.replace(/^Done when:\s*/, '').slice(0, 160)}” is not clearly in the prompt.`, { requirement: row.id });
  }
  for (const key of source.otherKeys || []) if (mentions(prompt, key) && !mentions(source.input, key)) add('warning', 'other-task', `The prompt mentions ${key}, which is not this task or one of its prerequisites.`);
  for (const name of source.rejected || []) if (mentions(prompt, name) && !mentions(source.input, name)) add('warning', 'rejected-technology', `The prompt mentions ${name}, which Origin marks as rejected.`);
  for (const warning of source.warnings || []) add('warning', 'origin', warning);
  if (source.notGrounded?.length) add('info', 'context-omitted', `${source.notGrounded.length} Origin context section${source.notGrounded.length === 1 ? ' was' : 's were'} too large to give to the prompt writer. The Kanban card still carries the full context.`);
  return { status: findings.some(row => row.severity === 'blocking') ? 'blocked' : findings.some(row => row.severity === 'warning') ? 'attention' : 'pass', findings, trace };
}
