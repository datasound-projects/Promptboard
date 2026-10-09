/**
 * Shared projects: one project, one ID, across Origin, Compose and Kanban. There is no separate registry:
 * the list is derived from Origin projects (with their linked board) and Kanban boards that no Origin
 * project uses. New links use the same ID on both sides; older links with different IDs keep working
 * through Origin's `kanbanProjectId`, and every ID of a project resolves to it. Each module still works
 * alone: Compose History never needs a project, and Kanban and Origin keep their own pages.
 *
 * Saved project prompts live in <dataDir>/prompts/<project>.json, separate from the browser-only Compose
 * History. Each prompt keeps every revision and its links to Origin records and Kanban cards. Saving a
 * prompt never creates a card; a card's instructions change only by an explicit update of an idle card.
 */
import '../public/origin-model.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readWithBackup, serial, writeAtomic } from './durable.mjs';
import { OriginError, escapeId } from './origin.mjs';

const Model = globalThis.PromptboardOriginModel;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SCHEMA = 'promptboard.project-prompts';
export const PROMPT_LIMITS = { prompts: 500, revisions: 100, promptBytes: 2 * 1024 * 1024, input: 100000, title: 120, links: 100, fileBytes: 64 * 1024 * 1024 };
const fail = (message, code = 'INVALID_INPUT', status = 400) => { throw new OriginError(message, code, status); };
const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
const PROVIDERS = ['codex', 'claude', 'gemini', 'agy'];

// ---- The project list ----

export async function listProjects({ origin, board }) {
  const [records, state] = await Promise.all([origin.list(), board.state()]);
  const boards = new Map(state.projects.map(project => [project.id, project]));
  const used = new Set(), projects = [];
  for (const record of records) {
    // A board with the Origin project's own ID is the same project, even without a stored link.
    const linked = boards.get(record.kanbanProjectId) || boards.get(record.id) || null;
    if (linked) used.add(linked.id);
    projects.push({ id: record.id, name: record.name, origin: { id: record.id, revision: record.revision }, kanban: linked ? { id: linked.id, name: linked.name, revision: linked.revision } : null, ids: [...new Set([record.id, ...(linked ? [linked.id] : [])])] });
  }
  for (const project of state.projects) if (!used.has(project.id)) projects.push({ id: project.id, name: project.name, origin: null, kanban: { id: project.id, name: project.name, revision: project.revision }, ids: [project.id] });
  return projects;
}
/** The shared project that owns `id`: the one whose own ID it is, else the one linked through it. */
export async function findProject(services, id) {
  const projects = await listProjects(services);
  const project = projects.find(entry => entry.id === id) || projects.find(entry => entry.ids.includes(id));
  if (!project) fail('This project no longer exists. Choose another project.', 'NOT_FOUND', 404);
  return project;
}

/** The shared project, other than the one with `exceptId`, that uses this name for itself or its board. One name, one project. */
export async function nameTaken(services, name, exceptId = null) {
  return (await listProjects(services)).find(project => !project.ids.includes(exceptId) && [project.name, project.kanban?.name].some(used => used && sameName(used, name))) || null;
}

/** Compose (or any page) asks for a project by name: an existing one of that name is selected, never duplicated. */
export async function ensureProject(services, { name }) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean || clean.length > 80 || clean.includes('\0')) fail('A project name needs 1 to 80 characters.');
  const existing = await nameTaken(services, clean);
  if (existing) return { project: existing, existing: true };
  try { return { project: await findProject(services, (await services.origin.create({ name: clean })).id), existing: false }; }
  catch (error) {
    // Another window created this name a moment ago: Origin checks names in its write queue.
    const raced = error.code === 'NAME_TAKEN' && await nameTaken(services, clean);
    if (!raced) throw error;
    return { project: raced, existing: true };
  }
}

/** A new board for an Origin project, with the project's ID when free, then linked. Kanban changes go only through the board service. */
export async function createBoardFor({ origin, board }, record, { name = record.name, folder = 'new', workflowMode = 'pipeline' } = {}) {
  const free = !(await board.state()).projects.some(entry => entry.id === record.id);
  const made = await board.createProjectWithRepository({ name, folder, workflowMode, ...(free ? { id: record.id } : {}) });
  return { ...made, record: await origin.link(record.id, { expectedRevision: record.revision, kanbanProjectId: made.project.id }) };
}

/** The project's Kanban board, created now (with the project's ID when free) if it has none. */
export async function ensureBoard(services, id) {
  const project = await findProject(services, id);
  if (project.kanban) return { project, created: false };
  await createBoardFor(services, await services.origin.read(project.origin.id, { report: false }));
  return { project: await findProject(services, project.origin.id), created: true };
}

/** The project's Origin blueprint, created with the board's ID if it has none. */
export async function ensureOrigin({ origin, board }, id) {
  const project = await findProject({ origin, board }, id);
  if (project.origin) return { project, created: false };
  await origin.create({ name: project.kanban.name, id: project.kanban.id, kanbanProjectId: project.kanban.id });
  return { project: await findProject({ origin, board }, id), created: true };
}

/**
 * Creating a board from Kanban (or Add to Kanban): a project of the same name that has no board yet gets
 * this board with its own ID; a project of that name that already has a board is refused. Otherwise a new
 * board is made as before.
 */
export async function createBoardProject(services, { name, folder = 'new', workflowMode = 'pipeline' }) {
  const clean = typeof name === 'string' ? name.trim() : '';
  const match = clean ? await nameTaken(services, clean) : null;
  if (match?.kanban) fail('A project with this name already exists.', 'NAME_TAKEN', 409);
  if (!match) return services.board.createProjectWithRepository({ name, folder, workflowMode });
  const { record, ...made } = await createBoardFor(services, await services.origin.read(match.origin.id, { report: false }), { folder, workflowMode });
  return { ...made, sharedWith: record.id };
}

// ---- Saved project prompts ----

function text(value, max, label, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) fail(`${label} needs ${required ? '1 to' : 'at most'} ${max.toLocaleString('en-US')} characters.`);
  return value;
}
function promptBody(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > PROMPT_LIMITS.promptBytes) fail('A saved prompt needs text of at most 2 MiB.');
  return value;
}
function settingsOf(value = {}) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pick = (key, max) => (typeof v[key] === 'string' ? v[key].slice(0, max) : '');
  return { provider: PROVIDERS.includes(v.provider) ? v.provider : '', model: pick('model', 100), effort: pick('effort', 20), language: pick('language', 10), quality: pick('quality', 20), task: pick('task', 40), detail: pick('detail', 20) };
}
function originLinks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROMPT_LIMITS.links) fail('Too many Origin links.');
  const seen = new Set();
  return value.map(link => {
    if (!link || !ID.test(link.originId) || !ID.test(link.id) || !Object.keys(Model.LIMITS).includes(link.collection)) fail('Choose a valid Origin record to link.');
    return { originId: link.originId, collection: link.collection, id: link.id };
  }).filter(link => { const key = `${link.originId}/${link.collection}/${link.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
const verificationOf = value => (['checks-passed', 'needs-review'].includes(value) ? value : 'none');
const current = prompt => prompt.revisions.at(-1);
const conflict = message => new OriginError(message, 'PROMPT_REVISION_CONFLICT', 409);

export class PromptStore {
  // ponytail: one queue for every project's prompts; per-project queues if saves ever contend.
  #serial = serial();
  constructor(dataDir) { this.dir = join(dataDir, 'prompts'); }
  #path(id) { if (!ID.test(id)) fail('Choose a valid project.', 'INVALID_PROJECT'); return join(this.dir, `prompts-${escapeId(id)}.json`); }
  async #load(id) {
    const path = this.#path(id);
    return await readWithBackup([path, `${path}.bak`], bytes => {
      let data; try { data = JSON.parse(bytes); } catch { return; }
      if (data?.schema === SCHEMA && data.version > 1) fail('These saved prompts were written by a newer Promptboard version. Update the app; nothing was changed.', 'PROMPTS_VERSION_UNSUPPORTED', 409);
      if (data?.schema === SCHEMA && data.version === 1 && Array.isArray(data.prompts)) return data;
    }) ?? { schema: SCHEMA, version: 1, projectId: id, prompts: [] };
  }
  async #save(data) {
    const path = this.#path(data.projectId), body = `${JSON.stringify(data, null, 1)}\n`;
    if (Buffer.byteLength(body) > PROMPT_LIMITS.fileBytes) fail('This project has too much saved prompt text. Delete old prompts first; nothing was saved.', 'LIMIT', 409);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { await writeAtomic(path, body); } catch { fail('The prompt could not be saved. Check free disk space and folder permissions. Nothing was changed.', 'PROMPTS_WRITE_FAILED', 500); }
  }
  /** Every prompt of a project, from each of its IDs (a project linked across different IDs keeps all of them). */
  list(ids) { return this.#serial(async () => (await Promise.all(ids.map(id => this.#load(id)))).flatMap(data => data.prompts.map(prompt => ({ ...prompt, storedUnder: data.projectId })))); }
  #find(ids, promptId) {
    return Promise.all(ids.map(id => this.#load(id))).then(files => {
      for (const data of files) { const prompt = data.prompts.find(entry => entry.id === promptId); if (prompt) return { data, prompt }; }
      fail('This saved prompt no longer exists.', 'NOT_FOUND', 404);
    });
  }
  /** Save a prompt. The same Compose result (history entry and text) is never saved twice in one project. */
  create(projectId, ids, input) {
    const now = Date.now();
    let prompt;
    try {
      const body = promptBody(input.prompt);
      prompt = { id: randomUUID(), title: text(input.title, PROMPT_LIMITS.title, 'A title', true).trim(), createdAt: now, updatedAt: now, revision: 1,
        revisions: [{ number: 1, prompt: body, input: text(input.input, PROMPT_LIMITS.input, 'The request'), settings: settingsOf(input.settings), verification: verificationOf(input.verification),
          historyId: typeof input.historyId === 'string' ? input.historyId.slice(0, 80) : '', savedAt: now, from: input.from === 'kanban' ? 'kanban' : 'compose' }],
        links: { origin: originLinks(input.origin), cards: [] } };
    } catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const all = await Promise.all(ids.map(id => this.#load(id)));
      const duplicate = all.flatMap(data => data.prompts).find(entry => entry.revisions.some(revision => revision.prompt === prompt.revisions[0].prompt && (!prompt.revisions[0].historyId || revision.historyId === prompt.revisions[0].historyId)));
      if (duplicate) return { prompt: duplicate, existing: true };
      const data = await this.#load(projectId);
      if (data.prompts.length >= PROMPT_LIMITS.prompts) fail(`A project can hold at most ${PROMPT_LIMITS.prompts} saved prompts.`, 'LIMIT', 409);
      data.prompts.unshift(prompt); await this.#save(data);
      return { prompt, existing: false };
    });
  }
  /** Change one prompt under its revision check. `update(prompt)` returns false to leave it unchanged. */
  change(ids, promptId, expectedRevision, update) {
    return this.#serial(async () => {
      const { data, prompt } = await this.#find(ids, promptId);
      if (prompt.revision !== expectedRevision) throw conflict('This saved prompt changed in another window. Reload it first.');
      const result = await update(prompt, data);
      if (result === false) return prompt;
      prompt.revision++; prompt.updatedAt = Date.now();
      await this.#save(data);
      return prompt;
    });
  }
  /** Move every prompt saved under `fromId` to `toId`, merged and none dropped: for when `fromId` goes away but the project stays. */
  merge(fromId, toId) {
    return this.#serial(async () => {
      const from = await this.#load(fromId);
      if (!from.prompts.length) return 0;
      const to = await this.#load(toId), known = new Set(to.prompts.map(prompt => prompt.id));
      to.prompts.push(...from.prompts.filter(prompt => !known.has(prompt.id)));
      await this.#save(to);
      for (const path of [this.#path(fromId), `${this.#path(fromId)}.bak`]) await rm(path, { force: true });
      return from.prompts.length;
    });
  }
  remove(ids, promptId, expectedRevision) {
    return this.#serial(async () => {
      const { data, prompt } = await this.#find(ids, promptId);
      if (prompt.revision !== expectedRevision) throw conflict('This saved prompt changed in another window. Reload it first.');
      data.prompts = data.prompts.filter(entry => entry.id !== promptId); await this.#save(data);
      return true;
    });
  }
}

/** A new revision. The previous ones stay; identical text adds nothing. */
export function addRevision(prompt, input) {
  const body = promptBody(input.prompt), last = current(prompt);
  if (body === last.prompt) return false;
  if (prompt.revisions.length >= PROMPT_LIMITS.revisions) fail(`A saved prompt keeps at most ${PROMPT_LIMITS.revisions} revisions. Save this one as a new prompt instead.`, 'LIMIT', 409);
  prompt.revisions.push({ number: last.number + 1, prompt: body, input: text(input.input ?? last.input, PROMPT_LIMITS.input, 'The request'), settings: settingsOf(input.settings ?? last.settings),
    verification: verificationOf(input.verification), historyId: typeof input.historyId === 'string' ? input.historyId.slice(0, 80) : '', savedAt: Date.now(), from: input.from === 'kanban' ? 'kanban' : 'compose' });
}

// ---- HTTP: /api/shared-projects ----

/** Prompt with names resolved from Origin and Kanban at read time (no copied names to go stale). */
async function promptView(prompt, { board, origin }, { full = false } = {}) {
  const state = await board.state(), tasks = new Map(state.projects.flatMap(project => project.tasks.map(task => [task.id, { project, task }])));
  const blueprints = new Map();
  for (const originId of new Set(prompt.links.origin.map(link => link.originId))) blueprints.set(originId, (await origin.read(originId, { report: false }).catch(() => null))?.blueprint || null);
  const last = current(prompt);
  return { id: prompt.id, title: prompt.title, createdAt: prompt.createdAt, updatedAt: prompt.updatedAt, revision: prompt.revision, current: last.number,
    prompt: last.prompt, input: last.input, settings: last.settings, verification: last.verification, historyId: last.historyId,
    revisions: full ? prompt.revisions : prompt.revisions.map(({ number, savedAt, from }) => ({ number, savedAt, from })),
    origin: prompt.links.origin.map(link => { const bp = blueprints.get(link.originId); return { ...link, name: bp ? Model.itemName(bp, link.collection, link.id) || '' : '', exists: Boolean(bp && Model.itemName(bp, link.collection, link.id)) }; }),
    cards: prompt.links.cards.map(link => {
      const found = tasks.get(link.taskId), task = found?.task;
      const column = found && (found.project.workflowMode === 'pipeline' ? found.project.pipeline.columns.find(entry => entry.id === task.column)?.title : task.column);
      return { ...link, exists: Boolean(task), number: task?.number ?? null, title: task?.title || '', column: column || '', edited: Boolean(task) && task.prompt !== prompt.revisions.find(revision => revision.number === link.promptRevision)?.prompt,
        behind: link.promptRevision !== last.number };
    }) };
}

export async function projectsRoute({ origin, board, prompts, req, res, pathname, jsonBody, send }) {
  const services = { origin, board }, method = req.method;
  const body = async (limit = 6 * 1024 * 1024) => { const value = await jsonBody(req, limit); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Send a JSON object.', 'INVALID_REQUEST'); return value; };
  const withCounts = async projects => Promise.all(projects.map(async project => ({ ...project, prompts: (await prompts.list(project.ids)).length })));
  if (pathname === '/api/shared-projects') {
    if (method === 'GET') return send(res, 200, { projects: await withCounts(await listProjects(services)) });
    if (method === 'POST') { const result = await ensureProject(services, await body()); return send(res, 200, { ...result, project: (await withCounts([result.project]))[0] }); }
  }
  const match = pathname.match(/^\/api\/shared-projects\/([A-Za-z0-9_-]{1,100})(?:\/(board|origin)|\/prompts(?:\/([A-Za-z0-9_-]{1,100})(?:\/(revisions|cards)(?:\/([A-Za-z0-9_-]{1,100})\/(update))?)?)?)?$/);
  if (!match) return send(res, 404, { error: 'This project route does not exist.' });
  const [, id, ensure, promptId, sub, taskId, update] = match;
  const project = await findProject(services, id);
  if (ensure && method === 'POST') { const result = await (ensure === 'board' ? ensureBoard : ensureOrigin)(services, id); return send(res, 200, { ...result, project: (await withCounts([result.project]))[0] }); }
  const view = async (prompt, extra = {}) => send(res, 200, { project, prompt: await promptView(prompt, services, { full: true }), ...extra });
  if (!promptId && pathname.endsWith('/prompts')) {
    if (method === 'GET') return send(res, 200, { project, prompts: await Promise.all((await prompts.list(project.ids)).sort((a, b) => b.updatedAt - a.updatedAt).map(prompt => promptView(prompt, services))) });
    if (method === 'POST') { const input = await body(); const { prompt, existing } = await prompts.create(project.id, project.ids, input); return view(prompt, { existing }); }
  }
  if (promptId && !sub) {
    if (method === 'GET') return view((await prompts.list(project.ids)).find(entry => entry.id === promptId) || fail('This saved prompt no longer exists.', 'NOT_FOUND', 404));
    if (method === 'PATCH') {
      const input = await body();
      return view(await prompts.change(project.ids, promptId, input.expectedRevision, prompt => {
        if (input.title !== undefined) prompt.title = text(input.title, PROMPT_LIMITS.title, 'A title', true).trim();
        if (input.origin !== undefined) prompt.links.origin = originLinks(input.origin);
      }));
    }
    if (method === 'DELETE') { const input = await body(); return send(res, 200, { deleted: await prompts.remove(project.ids, promptId, input.expectedRevision) }); }
  }
  if (sub === 'revisions' && !taskId && method === 'POST') {
    const input = await body();
    return view(await prompts.change(project.ids, promptId, input.expectedRevision, prompt => addRevision(prompt, input)));
  }
  if (sub === 'cards' && !taskId && method === 'POST') {
    // A card from the current revision. The board is created first only when asked; nothing starts.
    const input = await body();
    let target = project;
    if (!target.kanban) { if (input.createBoard !== true) fail('This project has no Kanban board yet.', 'NO_BOARD', 409); target = (await ensureBoard(services, id)).project; }
    let card;
    const saved = await prompts.change(target.ids, promptId, input.expectedRevision, async prompt => {
      const last = current(prompt);
      card = await board.createTask({ projectId: target.kanban.id, title: text(input.title ?? prompt.title, 120, 'A card title', true).trim(), prompt: last.prompt,
        source: { historyId: last.historyId, provider: last.settings.provider, model: last.settings.model, effort: last.settings.effort, language: last.settings.language, verification: last.verification,
          generatedAt: last.savedAt, projectId: target.id, promptId: prompt.id, promptRevision: last.number } });
      prompt.links.cards.push({ projectId: target.kanban.id, taskId: card.id, promptRevision: last.number, createdAt: Date.now() });
    }).catch(async error => {
      // The link was not saved: remove the new, untouched card again, so a retry does not make a second one.
      if (card && !await board.deleteTask(card.id, { expectedRevision: card.revision }).then(() => true, () => false)) {
        fail(`Card ${card.number} was created, but its link to this prompt could not be saved. Delete that card on the board before you try again.`, 'CARD_UNLINKED', 500);
      }
      throw error;
    });
    return view(saved, { project: target, task: { id: card.id, number: card.number, projectId: target.kanban.id } });
  }
  if (sub === 'cards' && update && method === 'POST') {
    // Update one linked card to the current revision: an idle card in To Do only, and an edited card only on request.
    const input = await body();
    const saved = await prompts.change(project.ids, promptId, input.expectedRevision, async prompt => {
      const link = prompt.links.cards.find(entry => entry.taskId === taskId) || fail('This card is not linked to the prompt.', 'NOT_FOUND', 404);
      const found = (await board.state()).projects.flatMap(entry => entry.tasks).find(task => task.id === taskId) || fail('This card no longer exists.', 'CARD_REMOVED', 409);
      const sent = prompt.revisions.find(revision => revision.number === link.promptRevision)?.prompt;
      if (found.prompt !== sent && input.replaceEdited !== true) fail('This card’s prompt was edited on the board. Confirm that those edits may be replaced.', 'CARD_EDITED', 409);
      const last = current(prompt);
      await board.refineTask(taskId, { prompt: last.prompt, expectedRevision: input.expectedCardRevision,
        source: { ...found.source, historyId: last.historyId, verification: last.verification, generatedAt: last.savedAt, projectId: project.id, promptId: prompt.id, promptRevision: last.number } });
      link.promptRevision = last.number;
    });
    return view(saved);
  }
  return send(res, 404, { error: 'This project route does not exist.' });
}
