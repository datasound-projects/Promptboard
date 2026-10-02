import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestServer } from './helpers/test-server.mjs';
import { AvatarJobs, generateAvatarImage, normalizeAvatarImage } from '../src/base-avatar.mjs';

const png = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=' };
async function world(t, options = {}) {
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [], ...options });
  const { token } = await fetch(app.url + '/api/session').then(response => response.json());
  const request = async (path, body) => {
    const response = await fetch(app.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-ste-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { ...app, request };
}

test('avatar generation is explicit, protected, draft-only and persists outside state with profile revisions', async t => {
  let calls = 0;
  const w = await world(t, { imageGenerator: async () => { calls++; return png; } });
  const profile = await w.board.base.create({ kind: 'profile', name: 'Engineer', configuration: { agent: { provider: 'claude' } } });
  assert.equal(calls, 0); assert.equal((await fetch(w.url + '/api/base/avatar/service')).status, 403);
  const result = await w.request('/api/base/avatar/generate', { resourceId: profile.id, expectedRevision: profile.revision, prompt: 'Illustrated purple scientist', operationId: 'avatar-fixture-operation' });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(calls, 1); assert.equal((await w.board.base.detail(profile.id)).revision, 1);
  const saved = await w.board.base.update(profile.id, { configuration: { ...profile.configuration, avatar: result.data.avatar }, content: { avatar: result.data.image } }, { expectedRevision: 1 });
  assert.equal(saved.revision, 2); assert.equal(saved.configuration.avatar.contentHash, normalizeAvatarImage(png).contentHash);
  assert.equal((await w.request(`/api/base/resources/${profile.id}/avatar`)).data.image.data, png.data);
  assert.doesNotMatch(await readFile(join(w.board.dataDir, 'state.json'), 'utf8'), new RegExp(png.data.slice(0, 20)));
  assert.equal((await w.board.state()).runs.length, 0);
  const portable = await w.board.base.export({ ids: [profile.id], includeContent: true });
  assert.equal(portable.resources[0].content.avatar.data, png.data);
  const imported = await w.board.base.import(portable); const remapped = await w.board.base.detail(imported.remap[profile.id]);
  assert.equal(remapped.content.avatar.data, png.data); assert.equal(remapped.enabled, false); assert.equal(remapped.trust, 'untrusted');
  const light = await w.board.base.export({ ids: [profile.id] }); assert.equal(light.resources[0].content, undefined);
  assert.equal(light.resources[0].configuration.avatar.contentStatus, 'omitted');
  await w.board.base.import(light);
  assert.equal((await w.board.base.detail(profile.id)).configuration.avatar.contentStatus, 'available', 'Export never mutates the original profile.');
});

test('image API uses the documented fixed endpoint and bounded output, never exposing credentials in errors', async () => {
  const environment = { OPENAI_API_KEY: 'PRIVATE_FIXTURE_SECRET' }; let request;
  const image = await generateAvatarImage('A scientist', { environment, fetcher: async (url, options) => {
    request = { url, options }; return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([255, 216, 255, 217]).toString('base64') }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations'); assert.equal(JSON.parse(request.options.body).output_format, 'jpeg'); assert.equal(image.mime, 'image/jpeg');
  await assert.rejects(generateAvatarImage('A scientist', { environment, fetcher: async () => { throw new Error('PRIVATE_FIXTURE_SECRET'); } }), error => error.code === 'BASE_AVATAR_NETWORK' && !error.message.includes('PRIVATE_FIXTURE_SECRET'));
  await assert.rejects(generateAvatarImage('A scientist', { environment: {} }), { code: 'BASE_AVATAR_AUTH_REQUIRED' });
  await assert.rejects(generateAvatarImage('A scientist', { environment, fetcher: async () => new Response('PRIVATE_FIXTURE_SECRET', { status: 401 }) }), error => !error.message.includes('PRIVATE_FIXTURE_SECRET'));
  assert.throws(() => normalizeAvatarImage({ mime: 'image/svg+xml', data: Buffer.from('<script/>').toString('base64') }));
});

test('avatar cancellation targets its own shared job and prevents persistence or an unrelated cancellation', async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const w = await world(t, { imageGenerator: async (_prompt, { signal }) => { enter(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const pending = w.request('/api/base/avatar/generate', { prompt: 'A scientist', operationId: 'avatar-running-operation' }); await entered;
  assert.equal((await w.request('/api/base/avatar/cancel', { operationId: 'avatar-unrelated-operation' })).data.cancelled, false);
  assert.equal((await w.request('/api/generate', { input: 'Unrelated Compose request', provider: 'codex' })).status, 409);
  assert.equal((await w.request('/api/base/avatar/cancel', { operationId: 'avatar-running-operation' })).data.cancelled, true);
  assert.ok((await pending).status >= 400); assert.equal((await w.request('/api/status')).data.busy, null); assert.equal((await w.board.base.list()).resources.length, 0);
});

test('avatar cancellation during initial profile lookup cannot start the image request', async () => {
  let release, called = false;
  const jobs = new AvatarJobs({ board: { base: { detail: () => new Promise(resolve => { release = resolve; }) } }, claim: async () => { called = true; }, track: value => value });
  const pending = jobs.generate({ resourceId: 'profile', expectedRevision: 1, prompt: 'Portrait', operationId: 'avatar-immediate-cancel' });
  jobs.cancel('avatar-immediate-cancel'); release({ kind: 'profile', revision: 1 }); await assert.rejects(pending); assert.equal(called, false);
});
