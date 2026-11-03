/** Knowledge from the installed application, never from web results or another release. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
// User-facing documentation only: design plans and historical implementation journals
// can describe features that this release does not have.
export const GUIDE_FILES = Object.freeze(['README.md', 'SECURITY.md', ...[
  'origin', 'origin-research', 'origin-project-context', 'compose-context', 'compose-batch',
  'shared-projects', 'kanban-execution', 'base-delivery', 'project-memory',
  'workspace-files', 'project-explorer', 'task-labels', 'task-priority', 'task-numbers',
  'schedules', 'coordinator', 'insights', 'live-preview', 'docker-sandbox', 'github', 'remote-access',
  'session-persistence', 'cli-adapters', 'pipeline-lifecycle', 'pipeline-prompts',
  'pipeline-task-authoring', 'pipeline-repository-configuration', 'pipeline-autopilot',
  'pipeline-automation-actions', 'pipeline-runtime-automations', 'pipeline-completed-tasks',
  'pipeline-notifications', 'live-native-messages', 'workspace-chat',
].map(name => `docs/${name}.md`), 'docs/network/user-guide.md',
  'docs/network/setup-mcp-a2a.md', 'docs/network/troubleshooting.md']);

export class ChatError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) { super(message); this.name = 'ChatError'; this.code = code; this.status = status; }
}
export const digest = text => createHash('sha256').update(text).digest('hex');
const plain = html => html.replace(/<svg\b[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[entity]).replace(/\s+/g, ' ').trim();

export function documentChunks(text, { title, path, page = '#/chat', kind = 'guide' }) {
  const result = [], headings = [];
  let lines = [], label = title;
  const flush = () => {
    const body = lines.join('\n').trim(); lines = [];
    if (!body) return;
    for (let offset = 0; offset < body.length; offset += 2800) {
      const excerpt = body.slice(offset, offset + 2800);
      result.push({ id: `s_${digest(`${path}\0${label}\0${offset}\0${excerpt}`).slice(0, 20)}`, title: label, path, page, kind, text: excerpt });
    }
  };
  for (const line of text.split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush(); headings.length = Math.min(headings.length, heading[1].length - 1);
      headings[heading[1].length - 1] = heading[2];
      label = [title, ...headings.filter(Boolean)].join(' › ');
    }
    lines.push(line);
  }
  flush(); return result;
}

async function applicationFiles(root) {
  const files = new Set(['package.json', 'package-lock.json', ...GUIDE_FILES]);
  async function walk(folder) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:m?js|html|css)$/.test(entry.name)) files.add(path);
    }
  }
  await walk('src'); await walk('public');
  const contents = [], missing = [];
  for (const path of [...files].sort()) {
    try { contents.push([path, (await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n')]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(path); }
  }
  return { contents, missing, hash: digest(JSON.stringify({ contents, missing })) };
}

const pageFor = path => /network/.test(path) ? '#/network' : /origin/.test(path) ? '#/origin' : /(?:compose|shared-projects)/.test(path) ? '#/' : /base/.test(path) ? '#/base' : /(?:kanban|pipeline|task-|schedules|workspace-files|project-explorer|project-memory|live-preview)/.test(path) ? '#/kanban' : '#/chat';

export async function loadChatKnowledge({ root = APP_ROOT } = {}) {
  const snapshot = await applicationFiles(root), files = new Map(snapshot.contents);
  const version = JSON.parse(files.get('package.json')).version;
  const build = { version, fingerprint: snapshot.hash, id: `${version}+${snapshot.hash.slice(0, 12)}` };
  const documents = [];
  for (const path of GUIDE_FILES) {
    const text = files.get(path); if (!text) continue;
    const title = /^#\s+(.+)$/m.exec(text)?.[1] || path;
    documents.push(...documentChunks(text, { title, path, page: pageFor(path) }));
  }
  // Settings labels, choices and help text come directly from this build's UI.
  // A new static setting is searchable even before the handbook gains a paragraph.
  const html = files.get('public/index.html') || '';
  documents.push(...documentChunks(plain(html), { title: 'Installed interface labels and help', path: 'public/index.html', kind: 'interface' }));
  const settings = html.match(/<dialog\b[^>]*id="app-settings"[\s\S]*?<\/dialog>/)?.[0] || '';
  documents.push(...documentChunks(plain(settings), { title: 'Settings: appearance, defaults, notifications, connections, terminal and data', path: 'public/index.html', kind: 'interface' }));
  for (const match of settings.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)) {
    const title = `Settings › ${plain(match[0].match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1] || 'Application settings')}`;
    const controls = [...match[0].matchAll(/<(?:input|select|textarea|button)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(row => row[1]);
    documents.push(...documentChunks(`${plain(match[0])}\nControl IDs: ${controls.join(', ')}`, { title, path: 'public/index.html', page: '#/chat', kind: 'interface' }));
  }
  const overview = {
    id: 's_app_overview', title: 'This installed version and its pages', path: 'application manifest', page: '#/chat', kind: 'guide',
    text: `Promptboard ${build.id}. Origin plans project blueprints and provides project Research. Compose prepares and saves prompts, with browser-local History and shared project prompts. Kanban manages projects, cards, worktrees, agents and execution pipelines. Base contains reusable resources and agent profiles. Network contains registrations, scoped memory, relationship graphs, durable jobs, pipelines, Activity, handoffs, schedules, private REST/MCP clients and opt-in A2A peers. Chat has two read-only agents: Workspace retrieves saved app data; App guide retrieves this installed version's user documentation and interface labels. Neither Chat agent changes project data or runs tasks. Settings opens from the top-right gear.\nAvailable guide files:\n${[...new Set(documents.map(d => d.path))].join('\n')}`,
  };
  return {
    build, documents: [overview, ...documents], missing: snapshot.missing.filter(path => GUIDE_FILES.includes(path)),
    async assertCurrent() {
      if ((await applicationFiles(root)).hash !== snapshot.hash) throw new ChatError('Application files changed after startup. Restart Promptboard to use guidance for the updated version.', 'VERSION_CHANGED', 409);
    },
  };
}

const STOP = new Set('a an the is are was were do does did how what where when why can could should would will to of for in on at with from and or me my i you your please about tell show explain this that app promptboard feature features all any some saved current currently have has had their there which these those whether anything everything exactly just use using get find list name names say says not assume'.split(' '));
export const searchWords = text => [...new Set(String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])].filter(word => (word.length > 1 || /^\d+$/.test(word)) && !STOP.has(word)).map(word => /^[a-z]{5,}s$/.test(word) && !/(?:ss|us|is)$/.test(word) ? word.slice(0, -1) : word);
export function evidenceScore(query, document) {
  const words = searchWords(query), title = document.title.toLowerCase(), body = document.text.toLowerCase();
  return words.reduce((score, word) => score + (title.includes(word) ? 8 : 0) + (body.includes(word) ? 1 + Math.min(3, body.split(word).length - 1) : 0), 0);
}
export function selectEvidence(query, documents, { max = 18, chars = 48000 } = {}) {
  const selected = [], seen = new Set(); let used = 0;
  const workspace = documents.some(document => document.id === 's_workspace_overview');
  const ranked = documents.map((document, index) => ({ document, index, score: evidenceScore(query, document) * (workspace && ['workspace', 'browser'].includes(document.kind) ? 3 : 1) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const overview = documents.filter(d => ['s_app_overview', 's_workspace_overview'].includes(d.id));
  const directory = workspace ? documents.filter(document => document.path === 'workspace-project-directory') : [];
  // A broad workspace question shares many words with long usage manuals. Reserve
  // room for actual records so those manuals cannot crowd out the requested facts.
  const records = workspace ? ranked.filter(row => row.score > 0 && ['workspace', 'browser'].includes(row.document.kind) && !overview.includes(row.document) && !directory.includes(row.document)).slice(0, Math.max(0, max - overview.length - directory.length - 5)).map(row => row.document) : [];
  for (const document of [...overview, ...directory, ...records, ...ranked.filter(row => row.score > 0).map(row => row.document)]) {
    if (seen.has(document.id) || selected.length >= max || used + document.text.length > chars) continue;
    selected.push(document); seen.add(document.id); used += document.text.length;
  }
  return selected;
}
