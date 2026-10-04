/** Prompt and automation boundaries. Pure rendering: no files, network calls, or environment reads. */
import { isAbsolute } from 'node:path';

const LIMIT = 2 * 1024 * 1024;
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
export const PIPELINE_VARIABLES = Object.freeze(['task_xml', 'title', 'description', 'taskId', 'taskNumber', 'projectPath', 'projectName',
  'worktreePath', 'branchName', 'baseBranch', 'prUrl', 'prNumber', 'prState', 'issueKey', 'issueUrl', 'labels', 'attachments', 'port', 'column', 'fromColumn', 'toColumn', 'trigger']);

export class PipelineTemplateError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_PIPELINE_TEMPLATE'; this.status = 400; }
}
const fail = message => { throw new PipelineTemplateError(message); };
function bounded(value) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > LIMIT) fail('Template text must be at most 2 MiB without null characters.');
  return value;
}
const string = value => {
  if (value === undefined || value === null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) fail('Template values must be text or primitive task metadata.');
  return bounded(String(value));
};
const xml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

/** Escape XML syntax, preserving description whitespace and line endings within the envelope. */
export function pipelineTaskEnvelope(task) {
  const title = string(task.title), description = string(task.prompt ?? task.description);
  const body = description.trim() ? (/\r|\n/.test(description) ? `\n  <description>\n${xml(description)}\n  </description>` : `\n  <description>${xml(description)}</description>`) : '';
  return bounded(`<task>\n  <title>${xml(title)}</title>${body}\n</task>`);
}

export function pipelineTemplateVariables({ task, project = null, attachmentPaths = [], port = null, move = null }) {
  if (!task || typeof task !== 'object') fail('Template rendering needs a task.');
  if (task.labels !== undefined && (!Array.isArray(task.labels) || task.labels.length > 100 || task.labels.some(label => typeof label !== 'string'))) fail('Task labels must be a bounded list of text values.');
  if (!Array.isArray(attachmentPaths) || attachmentPaths.length > 100 || attachmentPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path))) fail('Attachments need resolved absolute paths without line breaks.');
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) fail('Use an already reserved port from 1 to 65535.');
  const description = string(task.prompt ?? task.description), pr = task.evidence?.pullRequest || task.pullRequest || {}, external = task.externalSource || {};
  const values = { task_xml: pipelineTaskEnvelope(task), title: string(task.title), description: description.trim() ? `: ${description}` : '',
    taskId: string(task.id), taskNumber: Number.isSafeInteger(task.number) && task.number > 0 && task.number < Number.MAX_SAFE_INTEGER ? `#${task.number}` : '',
    projectPath: string(project?.repository?.root), projectName: string(project?.name),
    worktreePath: string(task.workspace?.path), branchName: string(task.workspace?.branch), baseBranch: string(task.baseBranch || project?.targetBranch?.name),
    prUrl: string(pr.url), prNumber: string(pr.number), prState: string(pr.isDraft ? 'draft' : pr.state).toLowerCase(),
    issueKey: string(external.key), issueUrl: string(external.url), labels: string((task.labels || []).join(', ')),
    attachments: attachmentPaths.length ? `\n${attachmentPaths.join('\n')}` : '', port: string(port),
    column: string(move?.column), fromColumn: string(move?.fromColumn), toColumn: string(move?.toColumn), trigger: string(move?.trigger) };
  for (const value of Object.values(values)) bounded(value);
  return Object.freeze(values);
}

const ESCAPES = {
  text: value => value,
  json: value => JSON.stringify(value).slice(1, -1),
  url: value => { try { return encodeURIComponent(value); } catch { fail('A URL template contains invalid Unicode.'); } },
  // Shell-independent stripping avoids guessing whether a substitution sits inside quotes.
  // Exact values are available separately through PROMPTBOARD_* environment variables.
  script: value => value.replace(/[\x00-\x1f\x7f`$%\\!"'&|;<>(){}\[\]#^]/g, ''),
};

/** A single pass never expands placeholders contained in a task's own text. */
export function renderPipelineTemplate(template, variables, format = 'text') {
  bounded(template);
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) fail('Template variables must be a text map.');
  const escape = ESCAPES[format];
  if (!Object.hasOwn(ESCAPES, format)) fail('Choose a supported template destination.');
  return bounded(template.replace(PLACEHOLDER, (placeholder, key) => Object.hasOwn(variables, key) ? escape(bounded(variables[key])) : placeholder));
}

export function unknownPipelineVariables(template, variables) {
  bounded(template);
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) fail('Template variables must be a text map.');
  return [...new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]).filter(key => !Object.hasOwn(variables, key)))];
}

/** Spawn templates omit unknown/empty keywords; whitespace cleanup touches literal template text only. */
export function renderPipelineSpawnPrompt(context, template = '{{task_xml}}{{attachments}}') {
  bounded(template);
  const variables = pipelineTemplateVariables({ ...context, move: null }), parts = [];
  let offset = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const literal = template.slice(offset, match.index);
    if (literal) parts.push({ literal: true, value: literal });
    const value = Object.hasOwn(variables, match[1]) ? variables[match[1]] : '';
    if (value) parts.push({ literal: false, value });
    offset = match.index + match[0].length;
  }
  if (offset < template.length) parts.push({ literal: true, value: template.slice(offset) });
  const joined = [];
  for (const part of parts) {
    if (part.literal && joined.at(-1)?.literal) joined.at(-1).value += part.value;
    else joined.push({ ...part });
  }
  return bounded(joined.map((part, index) => {
    if (!part.literal) return part.value;
    let value = part.value.replace(/[ \t]+/g, ' ').replace(/[ \t]+(?=\r?\n)/g, '');
    if (index === 0) value = value.trimStart();
    if (index === joined.length - 1) value = value.trimEnd();
    return value;
  }).join(''));
}

/** The caller supplies the native shell and must use quoted expansion rather than eval/re-parsing. */
export function pipelineScriptEnvironment(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) fail('Template variables must be a text map.');
  return Object.fromEntries(PIPELINE_VARIABLES.filter(key => Object.hasOwn(variables, key)).map(key => [
    `PROMPTBOARD_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`, bounded(variables[key]),
  ]));
}
