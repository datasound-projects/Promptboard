/**
 * Insights for one Kanban project, counted from what the board already records: rework rounds by agent, model and
 * template, time in each column, tokens and Claude Code's own price per merged card, and the cards whose review or
 * tests failed most. Read only: no model call, no file read per run, one pass over the project's newest runs and its
 * cards. See docs/insights.md.
 */
import { ADAPTERS } from './agents.mjs';
import { BoardError, columnStage, projectColumns, runStage } from './board.mjs';

const RUN_LIMIT = 5000;
const LOG_LIMIT = 100; // TRANSITION_LOG_LIMIT in board.mjs: a full move log has lost its oldest moves.
const DAY = 86400000;
const RANGES = ['30', '90', 'all'];
// Stages that check or plan work; every other agent run (Executing, a custom agent column) produces it.
const CHECKS = new Set(['planning', 'code_review', 'testing', 'merge']);
const NO_USAGE = new Set(['gemini', 'agy']);
const NO_PRICE = { claude: 'Claude Code reported no price for this conversation.', codex: 'Codex does not report a price.',
  gemini: 'Gemini CLI reports no tokens or price.', agy: 'Antigravity CLI reports no tokens or price.' };
const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const startOf = run => run.startedAt || run.createdAt || 0;
const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Rework rounds of a card: the review asked for changes, or tests failed. Column pipelines record them in the stage
 * history (a moved target branch or a resolved merge conflict is not a fault of the work, so it is no round). Boards
 * without a stage history count moves from Code Review or Testing back to Executing; a run that could not start
 * returns its card by itself ('system'), which is no round either.
 */
export function roundsOf(project, task) {
  if (task.stageHistory?.length) return task.stageHistory.flatMap(entry => {
    if (entry.status !== 'changes_required') return [];
    const kind = entry.stage === 'code_review' ? 'review' : entry.stage === 'testing' || entry.code === 'VERIFICATION_FAILED' ? 'tests' : null;
    return kind ? [{ at: entry.at, kind, reason: entry.reason || '' }] : [];
  });
  return (task.transitions || []).flatMap(move => {
    const from = columnStage(project, move.from);
    return move.by !== 'system' && columnStage(project, move.to) === 'executing' && ['code_review', 'testing'].includes(from)
      ? [{ at: move.at, kind: from === 'code_review' ? 'review' : 'tests', reason: move.reason || '' }] : [];
  });
}

/** Each stay of a card in a column, from entering to leaving; the column it is in now counts up to `now` (`open`). */
export function staysOf(task, now) {
  const all = task.transitions || [], moves = all.filter(move => move.from !== move.to && Number.isFinite(move.at));
  const stays = [];
  let column = moves[0]?.from ?? task.column, start = all.length >= LOG_LIMIT ? null : task.createdAt;
  for (const move of moves) {
    if (Number.isFinite(start) && move.from === column && move.at >= start) stays.push({ column, ms: move.at - start, end: move.at, open: false });
    column = move.to; start = move.at;
  }
  if (Number.isFinite(start) && column === task.column) stays.push({ column, ms: Math.max(0, now - start), end: now, open: true });
  return stays;
}

/**
 * Tokens and price of one card. Usage is cumulative per native conversation (a resumed run reads it from the start),
 * so each conversation counts once, at its highest numbers. Dollars are Claude Code's own estimate; any other agent
 * leaves the price unknown, with the reason.
 */
export function cardCost(runs) {
  const sessions = new Map(), unpriced = new Set();
  for (const run of runs) {
    const provider = run.config?.provider;
    if (!run.startedAt || !provider) continue;
    if (NO_USAGE.has(provider)) { unpriced.add(provider); continue; }
    const usage = run.usage;
    if (!usage) continue; // Claude Code and Codex report as they work; a run without a report adds nothing.
    const key = `${provider}:${run.providerSessionId || run.id}`, row = sessions.get(key) || { provider, input: 0, output: 0, cached: 0, usd: null };
    row.input = Math.max(row.input, count(usage.inputTokens)); row.output = Math.max(row.output, count(usage.outputTokens)); row.cached = Math.max(row.cached, count(usage.cachedTokens));
    if (Number.isFinite(usage.costUSD) && usage.costUSD >= 0) row.usd = Math.max(row.usd ?? 0, usage.costUSD);
    sessions.set(key, row);
  }
  let tokens = 0, cached = 0, usd = 0;
  for (const row of sessions.values()) { tokens += row.input + row.output; cached += row.cached; if (row.usd === null) unpriced.add(row.provider); else usd += row.usd; }
  const known = sessions.size > 0 && !unpriced.size;
  return { tokens, cachedTokens: cached, usd: known ? usd : null, priceNote: known ? '' : unpriced.size ? [...unpriced].map(id => NO_PRICE[id]).join(' ') : 'No agent usage was recorded.' };
}

/** A card's template: its Origin blueprint's template, else the saved prompt it came from. */
function templateOf(task, originLookup, promptLookup) {
  const originId = task.originSource?.originProjectId, name = originId ? originLookup.get(originId) : '';
  if (name) return name;
  const prompt = task.source?.promptId ? promptLookup.get(task.source.promptId) : '';
  if (prompt) return `Saved prompt: ${prompt}`;
  return originId && !originLookup.has(originId) ? 'Removed Origin project' : 'No template';
}

const tally = (map, key, label) => map.get(key) || map.set(key, { label, cards: 0, reworked: 0, rounds: 0 }).get(key);
const rows = map => [...map.values()].sort((a, b) => b.cards - a.cards || a.label.localeCompare(b.label));

/**
 * `days`: 30, 90 or null (all). `originLookup`: Origin project ID → template name ('' without one); a missing ID is a
 * removed project. `promptLookup`: saved prompt ID → title. Finished cards are cards in Done whose completion falls
 * in the range; time in columns counts stays that ended in the range or still go on.
 */
export function computeInsights(state, projectId, { days = 30, now = Date.now(), originLookup = new Map(), promptLookup = new Map() } = {}) {
  const project = state.projects.find(item => item.id === projectId);
  if (!project) throw new BoardError('This project does not exist. Reload the board.', 'NOT_FOUND', 404);
  const since = days ? now - days * DAY : -Infinity;
  const runsByTask = new Map();
  let seen = 0;
  for (let index = state.runs.length - 1; index >= 0 && seen < RUN_LIMIT; index--) {
    const run = state.runs[index];
    if (run.projectId !== projectId) continue;
    seen++;
    (runsByTask.get(run.taskId) || runsByTask.set(run.taskId, []).get(run.taskId)).push(run);
  }
  for (const list of runsByTask.values()) list.sort((a, b) => startOf(a) - startOf(b));
  const columns = projectColumns(project), doneId = project.workflowMode === 'pipeline' ? columns.find(column => column.role === 'done')?.id : 'done';
  const times = new Map(columns.filter(column => column.id !== doneId).map(column => [column.id, { id: column.id, title: column.title, durations: [], totalMs: 0, open: 0 }]));
  const agents = new Map(), models = new Map(), templates = new Map(), failingTemplates = new Map(), failing = [], merged = [], toMerge = [];
  const summary = { finished: 0, merged: 0, tokens: 0, cachedTokens: 0, priceUSD: 0, pricedCards: 0 };

  for (const task of project.tasks) {
    const runs = runsByTask.get(task.id) || [], rounds = roundsOf(project, task), template = templateOf(task, originLookup, promptLookup);
    for (const stay of staysOf(task, now)) {
      const row = times.get(stay.column);
      if (!row || stay.end < since) continue;
      row.durations.push(stay.ms); row.totalMs += stay.ms; if (stay.open) row.open++;
    }
    const recent = rounds.filter(round => round.at >= since);
    if (recent.length) {
      const latest = recent.reduce((a, b) => (b.at >= a.at ? b : a)), review = recent.filter(round => round.kind === 'review').length;
      failing.push({ id: task.id, number: task.number ?? null, title: task.title, review, tests: recent.length - review, total: recent.length, at: latest.at, reason: clip(latest.reason, 160), template });
      const row = tally(failingTemplates, template, template); row.cards++; row.rounds += recent.length;
    }
    // Everything below is about finished cards: in Done, completed in the range.
    if (task.column !== doneId) continue;
    const finishedAt = task.completion?.at ?? [...(task.transitions || [])].reverse().find(move => move.to === doneId)?.at ?? task.updatedAt;
    if (!(finishedAt >= since)) continue;
    summary.finished++;
    const cost = cardCost(runs);
    summary.tokens += cost.tokens; summary.cachedTokens += cost.cachedTokens;
    if (cost.usd !== null) { summary.pricedCards++; summary.priceUSD += cost.usd; }
    if (['merged', 'pull_request'].includes(task.completion?.kind)) {
      summary.merged++;
      merged.push({ id: task.id, number: task.number ?? null, title: task.title, ...cost });
      const first = runs.find(run => run.startedAt)?.startedAt;
      if (first && finishedAt >= first) toMerge.push(finishedAt - first);
    }
    // A round goes to the agent and model of the run whose work was sent back; the card counts once for each of them.
    const work = runs.filter(run => run.startedAt && run.config?.provider && !CHECKS.has(runStage(run)));
    const byAgent = new Map(), byModel = new Map();
    for (const run of work) {
      const provider = run.config.provider, model = run.usage?.model || run.config.model || '';
      byAgent.set(provider, { label: ADAPTERS[provider]?.name || provider, rounds: 0 });
      byModel.set(`${provider}\0${model}`, { label: `${ADAPTERS[provider]?.name || provider} · ${model || 'CLI default model'}`, rounds: 0 });
    }
    for (const round of rounds) {
      const run = work.findLast(item => startOf(item) <= round.at);
      if (!run) continue;
      byAgent.get(run.config.provider).rounds++;
      byModel.get(`${run.config.provider}\0${run.usage?.model || run.config.model || ''}`).rounds++;
    }
    for (const [map, own] of [[agents, byAgent], [models, byModel]]) for (const [key, { label, rounds: n }] of own) {
      const row = tally(map, key, label); row.cards++; row.rounds += n; if (n) row.reworked++;
    }
    const row = tally(templates, template, template); row.cards++; row.rounds += rounds.length; if (rounds.length) row.reworked++;
  }

  return {
    projectId, projectName: project.name, days: days || null, now, runsCapped: seen >= RUN_LIMIT,
    summary: { ...summary, priceUSD: summary.pricedCards ? summary.priceUSD : null, medianToMergeMs: median(toMerge) },
    rework: { agents: rows(agents), models: rows(models), templates: rows(templates) },
    columns: [...times.values()].map(({ durations, ...row }) => ({ ...row, stays: durations.length, medianMs: median(durations) })),
    cost: { medianTokens: median(merged.map(card => card.tokens)), cards: merged.sort((a, b) => b.tokens - a.tokens) },
    failing: { cards: failing.sort((a, b) => b.total - a.total || b.at - a.at).slice(0, 10), templates: failingTemplates.size > 1 ? rows(failingTemplates).sort((a, b) => b.rounds - a.rounds) : [] },
  };
}

/** GET /api/projects/:id/insights?days=30|90|all. Template names come through the Origin and saved-prompt stores. */
export async function projectInsights({ board, origin, prompts }, projectId, days) {
  const range = days ?? '30';
  if (!RANGES.includes(range)) throw new BoardError('Choose the last 30 days, 90 days or all.', 'INVALID_INPUT');
  const state = await board.state();
  const project = state.projects.find(item => item.id === projectId);
  if (!project) throw new BoardError('This project does not exist. Reload the board.', 'NOT_FOUND', 404);
  const originLookup = new Map();
  for (const id of new Set(project.tasks.map(task => task.originSource?.originProjectId).filter(Boolean))) {
    // A removed, damaged or unreadable Origin project has no template name to show.
    const record = await origin.read(id, { report: false }).catch(() => null);
    if (record && !record.damaged) originLookup.set(id, record.blueprint?.template?.name || '');
  }
  const owners = [...new Set(project.tasks.map(task => task.source?.promptId && task.source.projectId).filter(Boolean))];
  const saved = (await Promise.all(owners.map(id => prompts.list([id]).catch(() => [])))).flat();
  const promptLookup = new Map(saved.map(prompt => [prompt.id, prompt.title]));
  return computeInsights(state, projectId, { days: range === 'all' ? null : Number(range), now: Date.now(), originLookup, promptLookup });
}
