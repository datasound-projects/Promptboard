/** Read app-owned records through their services. No shell, repository traversal or credential store. */
import { redactLocal } from './compose-local.mjs';
import { ChatError, digest, documentChunks, evidenceScore } from './chat-knowledge.mjs';
import { readOnlySnapshot } from './durable.mjs';

const PRIVATE = /^(?:.*(?:api[_-]?key|auth[_-]?key|token(?:[_-]?(?:hash|sha256|hint))?|password|passwd|secret|private[_-]?key)|authorization|credentials?|headers?|env|environment|cookie|command|args|cwd|native|nativeSessionId|approvedRoots|.*(?:Path|Ref))$/i;
export function chatSafeValue(value, depth = 0, limits = { clipped: false }) {
  if (typeof value === 'string') { if (value.length > 16000) limits.clipped = true; return redactLocal(value.slice(0, 16000)); }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== 'object') return undefined;
  if (depth > 12) { limits.clipped = true; return '[not indexed: depth limit]'; }
  if (Array.isArray(value)) { if (value.length > 2000) limits.clipped = true; return value.slice(0, 2000).map(item => chatSafeValue(item, depth + 1, limits)); }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, item]) => [key, chatSafeValue(item, depth + 1, limits)]));
}
// Preserve natural multiline passages for exact quotation. JSON-escaping a saved
// report would otherwise turn its newlines into literal backslash-n sequences.
export function chatFacts(value, prefix = '') {
  if (typeof value === 'string') return value;
  if (value === undefined) return '[not recorded]';
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${prefix}[${index + 1}]:\n${chatFacts(item, `${prefix}[${index + 1}]`)}`).join('\n\n') : '(none)';
  return Object.entries(value).map(([key, item]) => `${prefix ? `${prefix}.` : ''}${key}: ${typeof item === 'object' && item !== null ? `\n${chatFacts(item, prefix ? `${prefix}.${key}` : key)}` : chatFacts(item)}`).join('\n');
}

export function browserContext(input) {
  if (input === undefined) return { history: [], catalog: [], total: 0, included: false };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['history', 'catalog', 'total'].includes(key))) throw new ChatError('Invalid browser history context.');
  if (!Array.isArray(input.history) || input.history.length > 30 || !Array.isArray(input.catalog) || input.catalog.length > 500 || !Number.isSafeInteger(input.total) || input.total < 0 || input.total > 500) throw new ChatError('Browser history exceeds the supported context size.');
  let size = 0;
  const rows = (list, detail) => list.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ChatError('Invalid browser history entry.');
    const out = {};
    for (const field of detail ? ['id', 'title', 'input', 'prompt', 'createdAt', 'provider', 'model'] : ['id', 'title', 'createdAt']) {
      if (row[field] === undefined) continue;
      if (!['string', 'number'].includes(typeof row[field])) throw new ChatError('Invalid browser history field.');
      const value = typeof row[field] === 'string' ? redactLocal(row[field].slice(0, detail ? 12000 : 200)) : row[field];
      size += String(value).length; out[field] = value;
    }
    return out;
  });
  const history = rows(input.history, true), catalog = rows(input.catalog, false);
  if (size > 160000) throw new ChatError('Browser history context is too large.');
  return { history, catalog, total: input.total, included: true };
}

export const collectChatWorkspace = (services, options) => readOnlySnapshot(() => collectWorkspace(services, options));
async function collectWorkspace(services, { question = '', browser = { history: [], catalog: [], total: 0 }, signal } = {}) {
  const startedAt = Date.now(), documents = [], unavailable = [], clipped = [], totals = {}, incomplete = new Set();
  const check = () => { if (signal?.aborted) throw new ChatError('The answer was cancelled.', 'ABORTED', 409); };
  const add = (title, path, page, value, kind = 'workspace') => {
    check();
    if (documents.length >= 20000) { if (!clipped.includes('workspace record limit')) clipped.push('workspace record limit'); return; }
    const limits = { clipped: false }, safe = chatSafeValue(value, 0, limits);
    if (limits.clipped) clipped.push(title);
    let text = chatFacts(safe);
    if (text.length > 48000) { clipped.push(title); text = text.slice(0, 48000) + '\n[This record was clipped.]'; }
    documents.push(...documentChunks(text, { title, path, page, kind }));
  };
  const read = async (label, work, fallback = null) => {
    check();
    try { const result = await work(); check(); return result; }
    catch (error) { check(); incomplete.add(label); unavailable.push({ source: label, code: /^[A-Z_]{1,60}$/.test(error.code || '') ? error.code : 'UNAVAILABLE' }); return fallback; }
  };
  async function pages(label, key, fetch, cap = 5000) {
    const rows = []; let offset = 0;
    for (;;) {
      const result = await read(label, () => fetch({ offset, limit: 100 }));
      if (!result) break;
      if (Number.isSafeInteger(result.total)) totals[label] = result.total;
      rows.push(...(result[key] || []));
      if (result.unavailable?.length) { incomplete.add(label); unavailable.push({ source: label, code: 'SOME_RECORDS_UNAVAILABLE', count: result.unavailable.length }); }
      if (result.next == null) break;
      if (rows.length >= cap || result.next <= offset) { clipped.push(`${label}: first ${rows.length} of ${result.total ?? 'unknown'} records`); break; }
      offset = result.next;
    }
    return rows;
  }
  const state = await services.board.state();
  const projects = state.projects || [];
  const origins = await read('Origin projects', () => services.origin.list(), []);
  if (services.origin.unreadable?.length) { incomplete.add('Origin projects'); unavailable.push({ source: 'Origin projects', code: 'SOME_RECORDS_UNAVAILABLE', count: services.origin.unreadable.length }); }
  const allIds = [...new Set([...projects.map(p => p.id), ...origins.map(p => p.id)])];
  // Older shared projects may link an Origin ID to a different Kanban ID.
  // Preserve both aliases without counting the same shared project twice.
  const boards = new Map(projects.map(project => [project.id, project])), linked = new Set();
  const directory = origins.map(origin => {
    const board = boards.get(origin.kanbanProjectId) || boards.get(origin.id);
    if (board) linked.add(board.id);
    return { id: origin.id, name: origin.name, ids: [...new Set([origin.id, ...(board ? [board.id] : [])])], origin: true, kanban: board ? { id: board.id, name: board.name } : null };
  });
  for (const project of projects) if (!linked.has(project.id)) directory.push({ id: project.id, name: project.name, ids: [project.id], origin: false, kanban: { id: project.id, name: project.name } });
  const names = new Map([...projects, ...origins].map(p => [p.id, p.name]));
  const projectName = id => names.get(id) || id;
  add('Saved global settings', 'Kanban settings', '#/kanban', state.settings);
  for (const project of projects) {
    const { tasks, ...metadata } = project;
    add(`Kanban project ${project.name}: settings, workflow and schedules`, `project:${project.id}`, '#/kanban', metadata);
    for (const task of tasks || []) add(`${project.name} › Kanban Card #${task.number}: ${task.title}`, `card:${project.id}/${task.id}`, '#/kanban', task);
    if (services.lessons?.snapshot) {
      const memory = await read(`Project memory ${project.name}`, () => services.lessons.snapshot(project.id));
      if (memory) add(`${project.name} › Project memory: saved lessons and settings`, `lessons:${project.id}`, '#/kanban', memory);
    }
    if (services.coordinator?.snapshot) {
      const coordinator = await read(`Coordinator ${project.name}`, () => services.coordinator.snapshot(project.id));
      if (coordinator) add(`${project.name} › Coordinator: previously saved observations`, `coordinator:${project.id}`, '#/kanban', coordinator);
    }
  }
  for (const run of state.runs || []) add(`${projectName(run.projectId)} › Agent run ${run.id}`, `run:${run.id}`, '#/kanban', run);
  for (const origin of origins) {
    const record = await read(`Origin ${origin.name}`, () => services.origin.read(origin.id, { report: false }));
    if (record?.damaged) { unavailable.push({ source: `Origin ${origin.name}`, code: 'DAMAGED_PROJECT' }); continue; }
    if (record) add(`Origin blueprint: ${origin.name}`, `origin:${origin.id}`, '#/origin', record);
    if (services.contexts) {
      const context = await read(`Project Context ${origin.name}`, () => services.contexts.read(origin.id));
      if (context) add(`Project Context: ${origin.name}`, `origin-context:${origin.id}`, '#/origin', context);
    }
    if (services.research) {
      const chats = await read(`Research ${origin.name}`, () => services.research.list(origin.id), []);
      for (const chat of chats.slice(0, 20)) {
        const value = await read(`Research conversation ${chat.title}`, () => services.research.read(origin.id, chat.id));
        if (value) add(`${origin.name} › Research: ${chat.title}`, `research:${origin.id}/${chat.id}`, '#/origin', { title: value.title, messages: value.messages.map(m => ({ role: m.role, text: m.text, createdAt: m.createdAt })), proposals: value.proposals });
      }
      if (chats.length > 20) clipped.push(`${origin.name}: latest 20 of ${chats.length} research conversations`);
    }
  }
  if (services.prompts) {
    const prompts = await read('Saved project prompts', () => services.prompts.list(allIds), []);
    for (const prompt of prompts) add(`${projectName(prompt.storedUnder)} › Saved Compose prompt: ${prompt.title}`, `compose:${prompt.storedUnder}/${prompt.id}`, '#/', prompt);
  }
  let batches = [];
  if (services.batches?.snapshot) {
    batches = await read('Compose batches', () => services.batches.list(), []);
    for (const batch of batches) {
      const value = await read(`Compose batch ${batch.name}`, () => services.batches.snapshot(batch.id));
      if (!value) continue;
      const { items, ...metadata } = value;
      add(`Compose batch: ${batch.name}`, `compose-batch:${batch.id}`, '#/', metadata);
      for (const item of items) add(`${batch.name} › Compose batch item: ${item.title}`, `compose-batch-item:${batch.id}/${item.id}`, '#/', item);
    }
  }
  const base = await read('Base library', () => services.board.base.list(), { resources: [] });
  for (const resource of base.resources || []) add(`Base ${resource.kind}: ${resource.name}`, `base:${resource.id}`, '#/base', resource);
  let agents = [], networks = [], jobs = [], pipelines = [], runs = [];
  if (services.network) {
    agents = await pages('Network agents', 'agents', options => services.network.listAgents(options));
    for (const agent of agents) add(`Network agent: ${agent.displayName}`, `network-agent:${agent.id}`, '#/network', agent);
    networks = await pages('Network graphs', 'networks', options => services.network.listNetworks({ ...options, archived: 'true' }));
    for (const network of networks) {
      const value = await read(`Graph ${network.name}`, () => services.network.network(network.id));
      if (value) add(`Network graph: ${network.name}`, `network:${network.id}`, '#/network', value.network);
    }
    // Notes and reports remain untrusted source data, with their approval/status intact.
    for (const scope of [...agents.map(a => ({ kind: 'agent', id: a.id, name: a.displayName })), ...networks.map(n => ({ kind: 'network', id: n.id, name: n.name }))]) {
      const hasMemory = !services.network.memory.exists || await read(`Memory ${scope.name}`, () => services.network.memory.exists(scope.kind, scope.id), false);
      const records = hasMemory ? await pages(`Memory ${scope.name}`, 'records', options => services.network.memory.list(scope.kind, scope.id, options), 1000) : [];
      for (const note of records) add(`${scope.name} › Memory (${note.status})`, `memory:${scope.kind}/${scope.id}/${note.id}`, '#/network', note);
      if (scope.kind === 'agent') {
        const posts = await pages(`Reports ${scope.name}`, 'posts', options => services.network.posts.list(scope.id, options), 1000);
        for (const post of posts) add(`${scope.name} › Saved report`, `post:${scope.id}/${post.id}`, '#/network', post);
      }
    }
    if (services.jobs) {
      jobs = await pages('Network jobs', 'jobs', options => services.jobs.list(options));
      for (const job of jobs) add(`Network job ${job.id}: ${job.status}`, `network-job:${job.id}`, '#/network', job);
      const relevant = jobs.map(job => ({ job, score: evidenceScore(question, { title: `job input result report ${job.id}`, text: JSON.stringify(chatSafeValue(job)) }) })).sort((a, b) => b.score - a.score).slice(0, 6);
      for (const { job } of relevant) {
        if (services.jobs.read) {
          const detail = await read(`Job details ${job.id}`, () => services.jobs.read(job.id));
          if (detail) add(`Accepted request and details of Network job ${job.id}`, `network-request:${job.id}`, '#/network', detail);
        }
        if (services.jobs.messagesOf) {
          const messages = await read(`Job messages ${job.id}`, () => services.jobs.messagesOf(job.id, { reader: { owner: true } }));
          if (messages) add(`Messages of Network job ${job.id}`, `network-messages:${job.id}`, '#/network', messages);
        }
        if (job.result) {
          const result = await read(`Job result ${job.id}`, () => services.jobs.result(job.id));
          if (result) add(`Result of Network job ${job.id}`, `network-result:${job.id}`, '#/network', result);
        }
      }
    }
    if (services.pipelines) {
      pipelines = await pages('Network pipelines', 'pipelines', options => services.pipelines.list(options));
      for (const pipeline of pipelines) {
        const value = await read(`Pipeline ${pipeline.name}`, () => services.pipelines.get(pipeline.id));
        if (value) add(`Network pipeline: ${pipeline.name}`, `pipeline:${pipeline.id}`, '#/network', value.pipeline);
      }
    }
    if (services.runs) {
      runs = await pages('Network pipeline runs', 'runs', options => services.runs.list(options));
      for (const run of runs) add(`Network pipeline run ${run.id}: ${run.status}`, `pipeline-run:${run.id}`, '#/network', run);
      const relevant = runs.map(run => ({ run, score: evidenceScore(question, { title: `pipeline report approval ${run.id}`, text: JSON.stringify(chatSafeValue(run)) }) })).sort((a, b) => b.score - a.score).slice(0, 6);
      for (const { run } of relevant) {
        const detail = await read(`Pipeline run ${run.id}`, () => services.runs.read(run.id));
        if (!detail) continue;
        add(`Pipeline steps: ${run.id}`, `pipeline-steps:${run.id}`, '#/network', detail);
        for (const node of detail.plan?.nodes || []) if (node.type === 'output' && detail.run.nodes[node.id]?.status === 'completed') {
          const report = await read(`Pipeline report ${run.id}/${node.id}`, () => services.runs.report(run.id, node.id));
          if (report) add(`Pipeline report: ${node.config.name}`, `pipeline-report:${run.id}/${node.id}`, '#/network', report);
        }
      }
    }
    if (services.schedules) add('Network schedules', 'network-schedules', '#/network', await read('Network schedules', () => services.schedules.list()));
    if (services.jobs?.delegation) add('Network handoff policy', 'network-handoffs', '#/network', await read('Network handoff policy', () => services.jobs.delegation.policy()));
    if (services.jobs?.settings) add('Network job engine settings', 'network-settings', '#/network', await read('Network job engine settings', () => services.jobs.settings()));
    if (services.network.federation?.view) add('Network A2A federation: public configuration and peers', 'network-federation', '#/network', await read('Network federation', () => services.network.federation.view()));
    if (services.machine) {
      const status = await read('Network machine listener', () => services.machine.status());
      if (status) add('Network machine listener', 'network-listener', '#/network', status.listener);
      const clients = await read('Network machine clients', () => services.machine.clients.list());
      if (clients) add('Network machine clients: scopes and status (no tokens)', 'network-clients', '#/network', clients);
    }
  }
  if (browser.included) {
    add('Compose history catalog in this browser (browser-provided)', 'browser-history-catalog', '#/', browser.catalog, 'browser');
    for (const item of browser.history) add(`Compose history in this browser: ${item.title || item.id}`, `browser-history:${item.id}`, '#/', item, 'browser');
  }
  const count = (label, known) => incomplete.has(label) ? null : totals[label] ?? known;
  const coverage = { projects: incomplete.has('Origin projects') ? null : directory.length, knownProjects: directory.length,
    originProjects: incomplete.has('Origin projects') ? null : origins.length, kanbanProjects: projects.length,
    kanbanCards: projects.reduce((total, project) => total + (project.tasks || []).length, 0), kanbanRuns: (state.runs || []).length,
    composeBatches: count('Compose batches', batches.length), baseResources: count('Base library', base.resources.length), networkAgents: count('Network agents', agents.length), graphs: count('Network graphs', networks.length), jobs: count('Network jobs', jobs.length), pipelines: count('Network pipelines', pipelines.length), pipelineRuns: count('Network pipeline runs', runs.length),
    indexed: { networkAgents: agents.length, graphs: networks.length, jobs: jobs.length, pipelines: pipelines.length, pipelineRuns: runs.length },
    browserHistory: { included: browser.included === true, total: browser.included ? browser.total : null, catalog: browser.catalog.length, selectedDetails: browser.history.length },
    unavailable, clipped: [...new Set(clipped)].slice(0, 200),
    limits: ['Linked repository file contents, unsaved edits, credentials and other browsers’ local History are not indexed.', 'Long fields and large collections are bounded; see clipped sources.', 'At most six relevant jobs (accepted inputs, messages and results) and six detailed pipeline runs/reports are read per retrieval.', 'Coordinator observations are previously saved history, not a freshly reconciled view; saved batch runs identify whether they are still active in this process.'] };
  add('All workspace projects: names and IDs', 'workspace-project-directory', '#/chat', directory);
  const overview = { id: 's_workspace_overview', title: 'Workspace retrieval coverage', path: 'live app services', page: '#/chat', kind: 'workspace',
    text: JSON.stringify({ ...coverage, clipped: coverage.clipped.slice(0, 15), directory: 'All project names and IDs are in the separate All workspace projects source. Do not call a retrieved subset the whole directory.' }, null, 2).slice(0, 8000) };
  const hash = digest(JSON.stringify([overview, ...documents].map(d => ({ id: d.id, text: d.text }))));
  return { documents: [overview, ...documents], coverage, hash, startedAt, capturedAt: Date.now() };
}
