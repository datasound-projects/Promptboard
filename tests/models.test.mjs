import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverModels, normalizeModels, parseAgyModels, metadataSession, checkModelEffort } from '../src/models.mjs';

test('model normalization preserves native effort choices and excludes unsafe or hidden IDs', () => {
  const models = normalizeModels('codex', [
    { model: 'future-model', displayName: 'Future model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }] },
    { model: '--unsafe' }, { model: 'hidden', hidden: true }, { model: 'future-model' },
  ]);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].efforts, ['low', 'xhigh']);
  assert.equal(models[0].defaultEffort, 'medium');
  assert.deepEqual(normalizeModels('claude', [{ value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'max'] }])[0].efforts, ['low', 'max']);
  assert.deepEqual(normalizeModels('claude', [{ value: 'haiku', supportsEffort: false, supportedEffortLevels: ['high'] }])[0].efforts, []);
  assert.deepEqual(normalizeModels('gemini', [{ modelId: 'gemini-future', name: 'Future' }])[0].efforts, []);
  assert.deepEqual(parseAgyModels('Available models:\n  gemini-new-high    Gemini New (High)\n  claude-sonnet-4-6    Claude Sonnet\n').map(m => m.id), ['gemini-new-high', 'claude-sonnet-4-6']);
  assert.throws(() => checkModelEffort('codex', 'future-model', 'high', { models }), { code: 'INVALID_EFFORT' });
  assert.doesNotThrow(() => checkModelEffort('codex', 'future-model', 'xhigh', { models }));
});

test('discovery uses native metadata handshakes and no inference prompts', { skip: process.platform === 'win32' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ste-catalog-test-'));
  const oldPath = process.env.PATH;
  const fixture = `#!${process.execPath}
const { createInterface } = require('node:readline');
const { basename } = require('node:path');
const args = process.argv.slice(2), provider = basename(process.argv[1]);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (provider === 'agy') {
  if (args.join(' ') !== 'models') process.exit(2);
  process.stdout.write('gemini-example-high    Gemini Example (High)\\n');
} else {
  let initialized = false;
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (provider === 'claude') {
      if (msg.request?.subtype !== 'initialize' || !args.includes('--input-format')) process.exit(2);
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { models: [{ value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }], account: { secret: 'NEVER_RETURN_THIS' } } } });
    } else if (msg.method === 'initialize') { initialized = true; send({ id: msg.id, result: {} }); }
    else if (msg.method === 'initialized') { if (!initialized) process.exit(2); }
    else if (provider === 'codex' && msg.method === 'model/list' && initialized) {
      send({ id: msg.id, result: { data: [{ model: msg.params.cursor ? 'model-two' : 'model-one', isDefault: !msg.params.cursor, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: msg.params.cursor ? null : 'next-page' } });
    } else if (provider === 'codex' && msg.method === 'config/read') send({ id: msg.id, result: { config: { model: 'model-two', model_reasoning_effort: 'high', api_key: 'NEVER_RETURN_THIS' } } });
    else if (provider === 'gemini' && msg.method === 'session/new' && initialized && args.includes('--experimental-acp')) {
      if (msg.params.mcpServers.length) process.exit(2);
      send({ id: msg.id, result: { sessionId: 'not-exposed', models: { currentModelId: 'gemini-example', availableModels: [{ modelId: 'gemini-example', name: 'Gemini Example' }] } } });
    } else process.exit(3);
  });
}
`;
  try {
    for (const provider of ['codex', 'claude', 'gemini', 'agy']) {
      await writeFile(join(cwd, provider), fixture); await chmod(join(cwd, provider), 0o700);
    }
    process.env.PATH = cwd;
    for (const provider of ['codex', 'claude', 'gemini', 'agy']) {
      const result = await discoverModels(provider);
      assert.equal(result.source, 'cli', `${provider}: ${result.note}`);
      assert.ok(result.models.length);
      assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN_THIS|not-exposed/);
      if (provider === 'codex') { assert.equal(result.models.length, 2); assert.equal(result.defaultModel, 'model-two'); assert.equal(result.defaultEffort, 'high'); }
      if (provider === 'claude') assert.deepEqual(result.models[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    }
    await writeFile(join(cwd, 'codex'), `#!${process.execPath}\nprocess.stderr.write('PRIVATE_KEY');process.exit(1);`);
    const unavailable = await discoverModels('codex');
    assert.equal(unavailable.source, 'unavailable');
    assert.deepEqual(unavailable.models, []);
    assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_KEY/);
    await assert.rejects(discoverModels('sh'), { code: 'INVALID_PROVIDER' });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('metadata processes have a timeout and support cancellation', async () => {
  const executable = { command: process.execPath, prefix: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'] };
  await assert.rejects(metadataSession(executable, [], tmpdir(), ({ request }) => request('initialize', {}), { timeoutMs: 80 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const promise = metadataSession(executable, [], tmpdir(), ({ request }) => request('initialize', {}), { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, { code: 'ABORTED' });
});
