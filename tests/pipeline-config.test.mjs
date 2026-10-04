import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPipelineConfig, normalizePipelineConfig, normalizePipelineStrategy, normalizePipelineAutomations, normalizePipelineTaskSelection, resolvePipelineStrategy } from '../src/pipeline-config.mjs';

const invalid = fn => assert.throws(fn, { code: 'INVALID_PIPELINE_CONFIG' });

test('task selections keep profiles and validated whole-task agent tuples exclusive and detached', () => {
  const config = defaultPipelineConfig(); config.profiles.push({ id: 'cheap', name: 'Cheap', columns: {} });
  assert.deepEqual(normalizePipelineTaskSelection(config), { profileId: null, agentOverride: null });
  assert.deepEqual(normalizePipelineTaskSelection(config, { profileId: 'cheap' }), { profileId: 'cheap', agentOverride: null });
  const input = { agentOverride: { agentOverride: 'codex', modelOverride: 'my-model', permissionMode: 'workspace-write' } };
  const result = normalizePipelineTaskSelection(config, input); result.agentOverride.modelOverride = 'changed';
  assert.equal(input.agentOverride.modelOverride, 'my-model');
  for (const wrong of [null, [], { profileId: '' }, { profileId: 'foreign' }, { profileId: 12 }, { profileId: 'cheap', agentOverride: { agentOverride: 'claude' } },
    { agentOverride: {} }, { agentOverride: false }, { agentOverride: { agentOverride: null } }, { agentOverride: { agentOverride: 'shell' } },
    { agentOverride: { agentOverride: 'claude', autoSpawn: true } }, { agentOverride: { agentOverride: 'codex', modelOverride: '--flag' } }, { command: 'execute' }]) invalid(() => normalizePipelineTaskSelection(config, wrong));
});

test('pipeline defaults seed seven silent columns with roles and a plan exit target', () => {
  const config = defaultPipelineConfig();
  assert.deepEqual(config.columns.map(column => column.name), ['To Do', 'Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
  for (const column of config.columns) {
    assert.equal(column.description, ''); assert.deepEqual(column.automations, { onEnter: [], onExit: [] });
    assert.equal(resolvePipelineStrategy(config, column.id).autoSpawn, column.role === 'active');
  }
  assert.equal(resolvePipelineStrategy(config, 'planning').permissionMode, 'plan');
  assert.equal(resolvePipelineStrategy(config, 'planning').planExitTargetId, 'executing');
  for (const id of ['executing', 'code_review', 'testing', 'merge']) assert.equal(resolvePipelineStrategy(config, id).permissionMode, null, 'Names must not force a permission mode or stage prompt.');
  config.columns[1].name = 'Changed'; assert.equal(defaultPipelineConfig().columns[1].name, 'Planning', 'Defaults are independent objects.');
});

test('column IDs retain strategy across rename, reorder, stage removal, and round trips', () => {
  const original = defaultPipelineConfig();
  original.columns = [original.columns[0], original.columns[4], original.columns[2], original.columns[6]];
  original.columns[1].name = 'Ship candidate'; original.columns[2].name = 'Build';
  const bytes = JSON.stringify(original), config = normalizePipelineConfig(JSON.parse(bytes));
  assert.deepEqual(config.columns.map(column => column.id), ['todo', 'testing', 'executing', 'done']);
  assert.equal(resolvePipelineStrategy(config, 'testing').autoSpawn, true);
  assert.equal(JSON.stringify(original), bytes, 'Validation cannot modify its input.');
  assert.deepEqual(normalizePipelineConfig(config), config);
});

test('system roles remain first/last, unique, independent of names, and never auto-spawn', () => {
  const config = defaultPipelineConfig();
  config.columns[0].name = 'Inbox'; config.columns.at(-1).name = 'Archive';
  config.columns[0].strategy = { autoSpawn: true }; config.columns.at(-1).strategy = { autoSpawn: true };
  const validated = normalizePipelineConfig(config);
  assert.equal(resolvePipelineStrategy(validated, 'todo').autoSpawn, false);
  assert.equal(resolvePipelineStrategy(validated, 'done').autoSpawn, false);
  for (const mutate of [value => value.columns.reverse(), value => value.columns[1].role = 'todo', value => value.columns[0].role = 'active', value => value.columns.at(-1).role = 'active']) {
    const wrong = defaultPipelineConfig(); mutate(wrong); invalid(() => normalizePipelineConfig(wrong));
  }
});

test('invalid targets, duplicate identity and unsupported configuration fail before execution', () => {
  for (const target of ['missing', 'planning', 'todo', 'done']) {
    const config = defaultPipelineConfig(); config.columns[1].strategy.planExitTargetId = target;
    invalid(() => normalizePipelineConfig(config));
  }
  for (const mutate of [value => value.version = 2, value => value.columns[2].id = 'todo', value => value.columns[2].name = ' planning ', value => value.columns[2].role = 'merge', value => value.columns[2].unknown = true, value => value.columns[2].id = '__proto__', value => value.columns[2].color = 'url(evil)', value => value.columns = Array(31).fill(value.columns[0])]) {
    const config = defaultPipelineConfig(); mutate(config); invalid(() => normalizePipelineConfig(config));
  }
});

test('sparse profiles distinguish inherit, cleared defaults, and explicit strategy values', () => {
  const config = defaultPipelineConfig();
  config.columns[2].strategy = { agentOverride: 'claude', modelOverride: 'pinned-model', effortOverride: 'high', autoSpawn: false, handoffContext: true };
  config.profiles = [{ id: 'economy', name: 'Economy', columns: { executing: { modelOverride: null, effortOverride: 'low', autoSpawn: null } } }];
  const normalized = normalizePipelineConfig(config), profile = normalized.profiles[0].columns.executing;
  assert.equal(Object.hasOwn(profile, 'agentOverride'), false); assert.equal(profile.modelOverride, null);
  const defaults = resolvePipelineStrategy(normalized, 'executing'), effective = resolvePipelineStrategy(normalized, 'executing', { profileId: 'economy' });
  assert.equal(defaults.modelOverride, 'pinned-model'); assert.equal(defaults.autoSpawn, false);
  assert.equal(effective.agentOverride, 'claude'); assert.equal(effective.modelOverride, null); assert.equal(effective.effortOverride, 'low'); assert.equal(effective.autoSpawn, true); assert.equal(effective.handoffContext, true);
  assert.equal(normalized.columns[2].strategy.modelOverride, 'pinned-model');
});

test('profiles cannot alter structure or automations and task overrides cannot coexist with profiles', () => {
  for (const strategy of [{ name: 'Renamed' }, { automations: {} }, { color: 'green' }, { role: 'done' }, { planExitTargetId: 'missing' }]) {
    const config = defaultPipelineConfig(); config.profiles = [{ id: 'profile', name: 'Profile', columns: { executing: strategy } }];
    invalid(() => normalizePipelineConfig(config));
  }
  const config = defaultPipelineConfig(); config.profiles = [{ id: 'profile', name: 'Profile', columns: {} }];
  config.columns[2].strategy = { agentOverride: 'claude', modelOverride: 'claude-model', effortOverride: 'max', permissionMode: 'acceptEdits', autoSpawn: false };
  invalid(() => resolvePipelineStrategy(config, 'executing', { profileId: 'profile', agentOverride: { agentOverride: 'codex' } }));
  invalid(() => resolvePipelineStrategy(config, 'executing', { profileId: 'missing' }));
  invalid(() => resolvePipelineStrategy(config, 'missing'));
  const own = resolvePipelineStrategy(config, 'executing', { agentOverride: { agentOverride: 'codex', modelOverride: 'codex-model' } });
  assert.equal(own.agentOverride, 'codex'); assert.equal(own.modelOverride, 'codex-model'); assert.equal(own.effortOverride, null); assert.equal(own.permissionMode, null); assert.equal(own.autoSpawn, false);
});

test('isolated session target and spawn policy stay independent for persistent side conversations', () => {
  const config = defaultPipelineConfig();
  config.columns[3].strategy = { sessionTarget: 'isolated', sessionSpawnStrategy: 'create_or_resume' };
  assert.equal(resolvePipelineStrategy(normalizePipelineConfig(config), 'code_review').sessionSpawnStrategy, 'create_or_resume');
  config.columns[3].strategy.sessionSpawnStrategy = 'always_spawn_new';
  assert.equal(resolvePipelineStrategy(normalizePipelineConfig(config), 'code_review').sessionSpawnStrategy, 'always_spawn_new');
});

test('strategy validation refuses unsafe permissions and flag-shaped models without broadening modes', () => {
  for (const input of [{ permissionMode: 'bypassPermissions' }, { permissionMode: 'yolo' }, { permissionMode: 'danger-full-access' }, { agentOverride: 'shell' }, { modelOverride: '--dangerously-skip-permissions' }, { autoSpawn: 'false' }, { handoffContext: 1 }, { sessionTarget: 'latest' }, { effortOverride: {} }, JSON.parse('{"__proto__":true}')]) invalid(() => normalizePipelineStrategy(input));
  assert.deepEqual(normalizePipelineStrategy({ modelOverride: null, autoSpawn: false }), { modelOverride: null, autoSpawn: false });
});

test('automation definitions preserve exact text, order, disabled rows, and template variables', () => {
  const message = '  Review {{title}}\r\nunknown {{future}}\n';
  const rows = { onEnter: [{ id: 'message', name: 'Review', type: 'send_message', message, mode: 'deferred' }, { id: 'script', name: 'Tests', type: 'run_script', enabled: false, script: 'npm test\n', timeoutMinutes: 2 }], onExit: [{ id: 'notify', name: 'Finish', type: 'notify' }, { id: 'webhook', name: 'Log', type: 'webhook', url: 'https://example.test/{{taskId}}', headers: { Authorization: '${ENV_REFERENCE}' } }] };
  const out = normalizePipelineAutomations(rows);
  assert.equal(out.onEnter[0].message, message); assert.equal(out.onEnter[0].mode, 'deferred');
  assert.equal(out.onEnter[1].script, 'npm test\n'); assert.equal(out.onEnter[1].enabled, false);
  assert.equal(out.onExit[0].title, '{{title}}'); assert.equal(out.onExit[0].body, '{{toColumn}}');
  assert.equal(out.onExit[1].method, 'POST'); assert.equal(out.onExit[1].body, '');
  assert.deepEqual(normalizePipelineAutomations(out), out);
  assert.equal(rows.onExit[0].title, undefined, 'Validation must not fill defaults into caller objects.');
});

test('automation validation bounds scripts and rejects header injection, retired types, and duplicate names across groups', () => {
  const row = { id: 'row', name: 'Row', type: 'send_message', message: 'Text' };
  invalid(() => normalizePipelineAutomations({ onEnter: [row], onExit: [{ ...row, id: 'other', name: 'row' }] }));
  invalid(() => normalizePipelineAutomations({ onEnter: Array(41).fill(row) }));
  for (const candidate of [{ ...row, type: 'kill_session' }, { ...row, message: '' }, { ...row, message: 'x'.repeat(64 * 1024 + 1) }, { ...row, mode: 'interrupt' }, { ...row, type: 'run_script', script: 'true', timeoutMinutes: 0 }, { name: 'Hook', type: 'webhook', url: 'https://user:password@example.test' }, { name: 'Hook', type: 'webhook', url: 'file:///etc/passwd' }, { name: 'Hook', type: 'webhook', url: 'https://example.test', headers: { Authorization: 'x\r\nInjected: y' } }, { name: 'Hook', type: 'webhook', url: 'https://example.test', headers: { Host: 'another.test' } }]) invalid(() => normalizePipelineAutomations({ onEnter: [candidate] }));
  const config = defaultPipelineConfig(); config.columns[0].automations.onEnter = [row]; invalid(() => normalizePipelineConfig(config));
});
