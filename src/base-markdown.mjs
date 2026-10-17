/**
 * Custom Markdown files in Base: agent instructions, identities, memory and rules (AGENTS.md, CLAUDE.md, GEMINI.md,
 * Copilot and Cursor rules, OpenClaw workspace files, or any .md of your own). Promptboard delivers an attached file as
 * part of the agent's prompt for every provider; whether a CLI would also read the file by itself depends on its own
 * conventions, listed here from their official documentation, and only when the file is in the repository.
 */
import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { writeAtomic } from './durable.mjs';

export class MarkdownError extends Error {
  constructor(message, code = 'BASE_INVALID_INPUT', status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new MarkdownError(message, code, status); };
export const MARKDOWN_LIMIT = 256 * 1024;

// [id, label, test(path), native: { provider: how it reads the file }, note]. Order matters: first match wins.
const CONVENTIONS = [
  ['skill', 'SKILL.md (Agent Skills)', path => posix.basename(path) === 'SKILL.md', {}, 'Skills are managed in Base → Skills.'],
  ['agents-override', 'AGENTS.override.md (Codex)', path => posix.basename(path) === 'AGENTS.override.md', { codex: 'read before AGENTS.md in the same folder' }, 'Codex CLI only.'],
  ['agents', 'AGENTS.md — cross-tool instructions', path => posix.basename(path) === 'AGENTS.md',
    { codex: 'read from the repository root down to the working folder', claude: 'read only when the repository has no CLAUDE.md', gemini: 'read only when context.fileName lists AGENTS.md', agy: 'read from the workspace' },
    'Open format read by many tools; the closest file to the edited code wins.'],
  ['claude', 'CLAUDE.md — Claude Code memory', path => ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].includes(path) || posix.basename(path) === 'CLAUDE.md', { claude: 'read at launch from the working folder and its parents' }, 'Claude Code project instructions.'],
  ['claude-rule', 'Claude Code rule', path => /^\.claude\/rules\/.+\.md$/.test(path), { claude: 'read from .claude/rules (scoped by its paths frontmatter)' }, 'A rule file under .claude/rules.'],
  ['gemini', 'GEMINI.md — Gemini CLI context', path => posix.basename(path) === 'GEMINI.md', { gemini: 'read from the workspace and its parents', agy: 'read from the workspace' }, 'Gemini CLI and Antigravity CLI context.'],
  ['copilot', 'GitHub Copilot instructions', path => path === '.github/copilot-instructions.md', {}, 'Read by GitHub Copilot, which Promptboard does not run.'],
  ['copilot-scoped', 'Copilot scoped instructions', path => /^\.github\/instructions\/[^/]+\.instructions\.md$/.test(path), {}, 'Needs applyTo frontmatter; read by GitHub Copilot.'],
  ['cursor-rule', 'Cursor rule (.mdc)', path => /^\.cursor\/rules\/.+\.mdc$/.test(path), {}, 'Frontmatter: description, globs, alwaysApply; read by Cursor.'],
  ['openclaw', 'OpenClaw workspace file', path => ['SOUL.md', 'IDENTITY.md', 'MEMORY.md', 'USER.md', 'BOOTSTRAP.md'].includes(posix.basename(path)), {}, 'Identity, personality and memory files of OpenClaw-style agents; no CLI that Promptboard runs reads them by itself.'],
  ['custom', 'Your own Markdown file', () => true, {}, 'Delivered by Promptboard when attached.'],
];
/** What a file name means: its convention, which CLIs read it natively from a repository, and a short note. */
export function markdownConvention(fileName) {
  const [id, label, , native, note] = CONVENTIONS.find(([, , test]) => test(fileName));
  return { id, label, native, note };
}
/** A repository-relative Markdown path: no absolute paths, parents or hidden secrets; .md, or .mdc under .cursor/rules. */
export function markdownFileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) fail('Name the file, for example AGENTS.md or docs/ARCHITECTURE.md.');
  const path = value.trim().replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || posix.normalize(path) !== path) fail('Use a relative path inside the repository, such as AGENTS.md or .github/copilot-instructions.md.');
  if (path.split('/').some(part => /^(?:\.git|node_modules|\.env(?:\..*)?)$/i.test(part))) fail('Markdown files cannot live in .git, node_modules or .env folders.');
  if (!/\.md$/i.test(path) && !(/\.mdc$/i.test(path) && path.startsWith('.cursor/rules/'))) fail('Use a .md file (or a .mdc Cursor rule under .cursor/rules).');
  if (posix.basename(path) === 'SKILL.md') fail('SKILL.md belongs in Base → Skills, where it is imported and checked as a skill.');
  return path;
}
/** Frontmatter as plain scalar key: value lines, and what is missing or odd for the file's convention. */
export function markdownFrontmatter(body, fileName) {
  const issues = [], meta = {};
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (body.startsWith('---') && !match) issues.push('The frontmatter has no closing --- line.');
  for (const line of match ? match[1].split(/\r?\n/) : []) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!field) { issues.push(`Frontmatter line not understood: ${line.slice(0, 60)}`); continue; }
    meta[field[1]] = field[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single);
  }
  const convention = markdownConvention(fileName).id;
  if (convention === 'copilot-scoped' && !meta.applyTo) issues.push('Copilot scoped instructions need an applyTo glob in their frontmatter.');
  if (convention === 'cursor-rule') {
    if (!match) issues.push('A Cursor rule needs frontmatter with description, globs or alwaysApply.');
    else if (meta.alwaysApply !== undefined && !['true', 'false'].includes(meta.alwaysApply)) issues.push('alwaysApply must be true or false.');
  }
  return { meta, issues };
}
export const ACTIVATION_MODES = ['always', 'projects', 'stages', 'providers', 'manual'];
/** When an attached file is sent: always, for some projects, some Kanban stages or columns, some CLIs, or only when attached to a task. */
export function normalizeActivation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Choose when the file is active.');
  const mode = value.mode || 'always';
  if (!ACTIVATION_MODES.includes(mode)) fail('Choose Always, Projects, Stages, Providers or On demand.');
  const list = (input, label, pattern) => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 50 || input.some(item => typeof item !== 'string' || !pattern.test(item))) fail(`${label} is invalid.`);
    return [...new Set(input)];
  };
  const out = { mode, projectIds: list(value.projectIds, 'Projects', /^[A-Za-z0-9_-]{1,100}$/), stages: list(value.stages, 'Stages', /^[A-Za-z0-9_-]{1,100}$/), providers: list(value.providers, 'Providers', /^(?:claude|codex|gemini|agy)$/) };
  if (mode === 'projects' && !out.projectIds.length) fail('Choose at least one project.');
  if (mode === 'stages' && !out.stages.length) fail('Choose at least one stage.');
  if (mode === 'providers' && !out.providers.length) fail('Choose at least one CLI.');
  return out;
}
/** Is the file sent in this run? `explicitTask`: it was attached to the task itself (On demand files need that). */
export function markdownActive(activation = { mode: 'always' }, { projectId, columnId, provider, explicitTask = false } = {}) {
  switch (activation.mode) {
    case 'projects': return activation.projectIds.includes(projectId) ? '' : 'Active only in other projects.';
    case 'stages': return activation.stages.includes(columnId) ? '' : 'Active only in other stages.';
    case 'providers': return activation.providers.includes(provider) ? '' : 'Active only for other CLIs.';
    case 'manual': return explicitTask ? '' : 'On demand: attach it to a task to send it.';
    default: return '';
  }
}

// ---- Optional starting points: every template is plain, editable Markdown ----
export const MARKDOWN_TEMPLATES = [
  { id: 'agents', name: 'AGENTS.md', fileName: 'AGENTS.md', description: 'Project instructions for coding agents.', body: '# AGENTS.md\n\n## Project overview\n\n## Setup and commands\n- Install:\n- Test:\n- Lint:\n\n## Code style\n\n## Testing instructions\n\n## Boundaries\n- Do not:\n' },
  { id: 'claude', name: 'CLAUDE.md', fileName: 'CLAUDE.md', description: 'Claude Code project instructions.', body: '# CLAUDE.md\n\n## What this project is\n\n## Commands\n\n## Conventions\n\n## Things to avoid\n' },
  { id: 'gemini', name: 'GEMINI.md', fileName: 'GEMINI.md', description: 'Gemini CLI context.', body: '# GEMINI.md\n\n## Project\n\n## Conventions\n\n## Commands\n' },
  { id: 'soul', name: 'SOUL.md', fileName: 'SOUL.md', description: 'Personality, principles and communication style.', body: '# SOUL.md\n\n## Principles\n\n## How I communicate\n\n## Boundaries\n' },
  { id: 'identity', name: 'IDENTITY.md', fileName: 'IDENTITY.md', description: 'Role and identity of an agent.', body: '# IDENTITY.md\n\n- Name:\n- Role:\n- Responsible for:\n- Not responsible for:\n' },
  { id: 'memory', name: 'MEMORY.md', fileName: 'MEMORY.md', description: 'Decisions and findings worth remembering.', body: '# MEMORY.md\n\n## Decisions\n\n## Findings\n\n## Open questions\n' },
  { id: 'research', name: 'RESEARCH.md', fileName: 'RESEARCH.md', description: 'Research method and validation standards.', body: '# RESEARCH.md\n\n## Method\n\n## Sources to prefer\n\n## How findings are validated\n' },
  { id: 'architecture', name: 'ARCHITECTURE.md', fileName: 'ARCHITECTURE.md', description: 'Architecture overview and constraints.', body: '# ARCHITECTURE.md\n\n## Context\n\n## Main components\n\n## Constraints\n\n## Decisions\n' },
  { id: 'workflow', name: 'WORKFLOW.md', fileName: 'WORKFLOW.md', description: 'How work moves from task to merge.', body: '# WORKFLOW.md\n\n## Branches\n\n## Reviews\n\n## Definition of done\n' },
  { id: 'copilot', name: 'Copilot instructions', fileName: '.github/copilot-instructions.md', description: 'Repository instructions for GitHub Copilot.', body: '# Copilot instructions\n\n' },
  { id: 'cursor', name: 'Cursor rule', fileName: '.cursor/rules/project.mdc', description: 'A Cursor project rule.', body: '---\ndescription: Project conventions\nalwaysApply: true\n---\n\n# Project conventions\n' },
];

// ---- Repository import: find the instruction files a project already has (read only) ----
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.venv', 'venv', 'target', '.next', 'coverage']);
const known = path => markdownConvention(path).id !== 'custom';
/** Instruction files in a repository: known conventions anywhere up to four folders deep, plus skills to import as skills. */
export async function scanRepository(root, { maxFiles = 200 } = {}) {
  const base = await realpath(root).catch(() => fail('The project folder is missing.', 'FOLDER_MISSING', 409)), found = [];
  async function walk(dir, depth) {
    if (found.length >= maxFiles || depth > 4) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (found.length >= maxFiles) return;
      const full = join(dir, entry.name), path = relative(base, full).split(sep).join('/');
      if (entry.isSymbolicLink()) continue; // A link could point outside the repository.
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await walk(full, depth + 1); continue; }
      if (!entry.isFile() || !/\.mdc?$/i.test(entry.name) || !known(path)) continue;
      const info = await stat(full).catch(() => null);
      if (!info || info.size > MARKDOWN_LIMIT) continue;
      found.push({ path, size: info.size, convention: markdownConvention(path).id });
    }
  }
  await walk(base, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
/** Read one file the scan found: inside the repository, not a link, within the size limit. */
export async function readRepositoryFile(root, path) {
  const base = await realpath(root), full = join(base, ...path.split('/'));
  const info = await lstat(full).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) fail(`${path} is not a file in the repository.`, 'BASE_NOT_FOUND', 404);
  const actual = await realpath(full);
  if (relative(base, actual).startsWith('..')) fail('The file is outside the repository.');
  if (info.size > MARKDOWN_LIMIT) fail(`${path} is larger than 256 KiB.`);
  return readFile(actual, 'utf8');
}
/**
 * Put a file at its conventional place in a repository, so a CLI that reads it natively finds it. Nothing is written
 * without `confirm`, and an existing file is replaced only when `expectedHash` matches what was previewed.
 */
export async function deployToRepository(root, fileName, body, { confirm = false, expectedHash = null, hash }) {
  const base = await realpath(root).catch(() => fail('The project folder is missing.', 'FOLDER_MISSING', 409)), full = join(base, ...fileName.split('/'));
  if (relative(base, full).startsWith('..')) fail('The file would be outside the repository.');
  // A folder on the way that is a link could lead outside the repository: the real folder must stay inside it.
  const folder = await realpath(dirname(full)).catch(() => null);
  if (folder && relative(base, folder).startsWith('..')) fail('A folder on the way to this file leads outside the repository; nothing is written through it.');
  const current = await lstat(full).then(async info => { if (info.isSymbolicLink() || !info.isFile()) fail(`${fileName} exists and is not a plain file; it is left as it is.`, 'BASE_DEPLOY_CONFLICT', 409); return readFile(full, 'utf8'); }, () => null);
  const preview = { path: fileName, exists: current !== null, currentHash: current === null ? null : hash(current), same: current === body, currentChars: current?.length || 0, newChars: body.length };
  if (!confirm || preview.same) return { ...preview, written: false };
  if (preview.exists && expectedHash !== preview.currentHash) fail(`${fileName} changed since the preview. Review it again before replacing it.`, 'BASE_DEPLOY_CONFLICT', 409);
  if (!folder) { await mkdir(dirname(full), { recursive: true }); if (relative(base, await realpath(dirname(full))).startsWith('..')) fail('The file would be outside the repository.'); }
  await writeAtomic(full, body, { backup: false });
  return { ...preview, written: true };
}
