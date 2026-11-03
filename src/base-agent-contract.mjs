/** Portable agent requirements. Enforcement belongs to the runner, never to a prompt alone. */
import { isDeepStrictEqual } from 'node:util';
const object = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bad = message => { throw Object.assign(new Error(message), { code: 'BASE_CONTRACT_INVALID', status: 400 }); };
const fields = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) bad('Unknown or invalid agent requirement.'); };
const text = (value, max = 2000) => { if (typeof value !== 'string' || value.length > max || /[\0\x1b]/.test(value)) bad('Agent requirement text is invalid or too long.'); return value.trim(); };
const list = (value, max = 20) => { if (!Array.isArray(value) || value.length > max) bad('Too many agent requirements.'); return [...new Set(value.map(v => text(v)))].filter(Boolean); };
const keys = ['type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'];
function jsonValue(value, depth = 0) {
  if (depth > 8) bad('Schema values are too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)]));
  bad('Schema values must be portable JSON.');
}

export function agentSchema(value, depth = 0) {
  fields(value, keys);
  let encoded; try { encoded = JSON.stringify(value); } catch { bad('Output schema must be portable JSON.'); }
  if (depth > 8 || encoded.length > 20000) bad('Output schema is too large or deeply nested.');
  if (value.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type)) bad('Choose a supported JSON type.');
  const out = { ...value };
  if (out.properties !== undefined) {
    if (!object(out.properties) || Object.keys(out.properties).length > 50) bad('A schema supports at most 50 properties.');
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, schema]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 100) bad('Invalid schema property.');
      return [key, agentSchema(schema, depth + 1)];
    }));
  }
  if (out.items !== undefined) out.items = agentSchema(out.items, depth + 1);
  if (out.required !== undefined) out.required = list(out.required, 50);
  if (out.additionalProperties !== undefined && typeof out.additionalProperties !== 'boolean') bad('Additional properties must be on or off.');
  if (out.enum !== undefined && (!Array.isArray(out.enum) || !out.enum.length || out.enum.length > 50)) bad('An enum needs 1–50 values.');
  if (out.enum !== undefined) out.enum = out.enum.map(item => jsonValue(item));
  if (out.const !== undefined) out.const = jsonValue(out.const);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (out[key] !== undefined && (!Number.isSafeInteger(out[key]) || out[key] < 0 || out[key] > 100000)) bad('Schema size limits must be integers between 0 and 100000.');
  for (const key of ['minimum', 'maximum']) if (out[key] !== undefined && !Number.isFinite(out[key])) bad('Schema numeric limits must be finite.');
  for (const [min, max] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']]) if (out[min] !== undefined && out[max] !== undefined && out[min] > out[max]) bad('A schema minimum cannot exceed its maximum.');
  for (const key of ['description', 'title']) if (out[key] !== undefined) out[key] = text(out[key]);
  return out;
}

export function normalizeAgentContract(value) {
  if (value === undefined) return undefined;
  fields(value, ['version', 'output', 'checks', 'runtime', 'memory', 'evaluations', 'mcpMode']);
  if (value.version !== undefined && value.version !== 1) bad('This agent requirement version is unsupported.');
  const out = { version: 1 };
  if (value.mcpMode !== undefined) {
    if (!['inherit', 'base-only'].includes(value.mcpMode)) bad('Choose inherited or Base-only MCP connections.');
    out.mcpMode = value.mcpMode;
  }
  if (value.output !== undefined) {
    fields(value.output, ['format', 'schema']);
    if (!['text', 'markdown', 'json'].includes(value.output.format)) bad('Choose Text, Markdown or JSON output.');
    if (value.output.schema !== undefined && value.output.format !== 'json') bad('A JSON schema requires JSON output.');
    out.output = { format: value.output.format, ...(value.output.schema ? { schema: agentSchema(value.output.schema) } : {}) };
  }
  if (value.checks !== undefined) {
    fields(value.checks, ['contains', 'excludes']);
    out.checks = { contains: list(value.checks.contains || []), excludes: list(value.checks.excludes || []) };
    if (out.checks.contains.some(required => out.checks.excludes.some(forbidden => required.includes(forbidden)))) bad('Required text cannot also contain prohibited text.');
  }
  if (value.runtime !== undefined) {
    fields(value.runtime, ['timeoutMinutes', 'contextChars', 'targets']); out.runtime = {};
    for (const [key, min, max] of [['timeoutMinutes', 1, 120], ['contextChars', 1000, 100000]]) if (value.runtime[key] !== undefined) {
      if (!Number.isSafeInteger(value.runtime[key]) || value.runtime[key] < min || value.runtime[key] > max) bad(`${key} must be between ${min} and ${max}.`);
      out.runtime[key] = value.runtime[key];
    }
    if (value.runtime.targets !== undefined) {
      if (!Array.isArray(value.runtime.targets) || !value.runtime.targets.length || value.runtime.targets.some(t => !['kanban', 'network'].includes(t))) bad('Choose Kanban, Network or both execution targets.');
      out.runtime.targets = [...new Set(value.runtime.targets)];
    }
  }
  if (value.memory !== undefined) {
    fields(value.memory, ['agent', 'network', 'projectLessons']);
    if (Object.values(value.memory).some(v => typeof v !== 'boolean')) bad('Memory permissions must be on or off.');
    out.memory = { ...value.memory };
  }
  if (value.evaluations !== undefined) {
    if (!Array.isArray(value.evaluations) || value.evaluations.length > 10) bad('Keep at most 10 agent test cases.');
    out.evaluations = value.evaluations.map(item => { fields(item, ['name', 'input', 'contains', 'excludes']); const name = text(item.name || '', 100), input = text(item.input || '', 8000); if (!name || !input) bad('Each test needs a name and question.'); return { name, input, contains: list(item.contains || []), excludes: list(item.excludes || []) }; });
  }
  return out;
}

export function validateAgentOutput(answer, contracts = []) {
  const errors = [];
  const checkSchema = (schema, value, path = '$') => {
    if (errors.length >= 30) return;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (schema.type && !(schema.type === type || schema.type === 'integer' && type === 'number' && Number.isInteger(value))) { errors.push(`${path}: expected ${schema.type}`); return; }
    if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) errors.push(`${path}: does not match the required value`);
    if (schema.enum && !schema.enum.some(v => isDeepStrictEqual(value, v))) errors.push(`${path}: value is not in the allowed list`);
    if (type === 'object') {
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
      for (const [key, item] of Object.entries(value)) { if (errors.length >= 30) break; const child = `${path}.${key.slice(0, 100)}`; if (schema.properties && Object.hasOwn(schema.properties, key)) checkSchema(schema.properties[key], item, child); else if (schema.additionalProperties === false) errors.push(`${child}: additional property`); }
    }
    if (type === 'array') { if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: array length outside the limit`); if (schema.items) for (const [i, item] of value.entries()) checkSchema(schema.items, item, `${path}[${i}]`); }
    if (type === 'string' && (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength)) errors.push(`${path}: text length outside the limit`);
    if (type === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) errors.push(`${path}: number outside the limit`);
  };
  for (const raw of contracts) {
    const c = normalizeAgentContract(raw); if (!c) continue;
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 500000) { errors.push('The final answer is missing or exceeds the validation limit.'); continue; }
    if (c.output?.format === 'json') { try { const value = JSON.parse(answer.trim()); if (c.output.schema) checkSchema(c.output.schema, value); } catch { errors.push('The final answer must be valid JSON without surrounding prose or code fences.'); } }
    for (const word of c.checks?.contains || []) if (!answer.includes(word)) errors.push(`Missing required text: ${word.slice(0, 100)}`);
    for (const word of c.checks?.excludes || []) if (answer.includes(word)) errors.push(`Contains prohibited text: ${word.slice(0, 100)}`);
  }
  return { passed: errors.length === 0, errors: errors.slice(0, 30).map(error => error.slice(0, 500)) };
}

export function contractRequirements(contracts = []) {
  const result = { timeoutMs: null, contextChars: 100000, mcpMode: 'inherit', targets: ['kanban', 'network'], memory: { agent: true, network: true, projectLessons: true } };
  for (const raw of contracts) {
    const c = normalizeAgentContract(raw); if (!c) continue;
    if (c.runtime?.timeoutMinutes) result.timeoutMs = Math.min(result.timeoutMs ?? Infinity, c.runtime.timeoutMinutes * 60000);
    if (c.runtime?.contextChars) result.contextChars = Math.min(result.contextChars, c.runtime.contextChars);
    if (c.runtime?.targets) result.targets = result.targets.filter(t => c.runtime.targets.includes(t));
    if (c.mcpMode === 'base-only') result.mcpMode = 'base-only';
    for (const key of Object.keys(result.memory)) if (c.memory?.[key] === false) result.memory[key] = false;
  }
  return result;
}

export function contractPrompt(contracts = []) {
  return contracts.filter(Boolean).map(c => `Agent output requirements (validated after the final answer):\n${JSON.stringify({ output: c.output, checks: c.checks })}`).join('\n\n');
}
