/**
 * Shared fixture for the external-client tests (tests/network-machine.test.mjs, tests/network-mcp.test.mjs): a board with
 * projects Site and Docs and Base agents Lead (Claude), Scout (Codex) and Gem (Gemini), the real server with the given
 * Network worker (the deterministic fake, or null), and helpers for the owner API, clients and the machine listener.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../../src/board.mjs';
import { startServer } from '../../src/server.mjs';
import { fakeWorker } from './network-worker.mjs';

export const ALL = ['read_agents', 'submit_jobs', 'read_job_result', 'cancel_own_jobs'];
export const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}
/** One HTTP request with any headers (fetch cannot set Host). Resolves once the answer is read; a later socket error is ignored. */
export function request(port, path, { method = 'GET', headers = {}, body, raw, host = `127.0.0.1:${port}` } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
export const refused = port => new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', error => resolve(error.code === 'ECONNREFUSED')); });

/** A board with projects Site and Docs, Base agents (Claude, Codex, Gemini), then the app. `dataDir` restarts on a used folder. */
export async function fixture(t, { dataDir = null, worker = fakeWorker(), machineOptions, serverOptions = {} } = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'pb-network-machine-'));
    t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const board = new Board({ dataDir });
    await board.createProject({ name: 'Site' }); await board.createProject({ name: 'Docs' });
    await board.base.create({ id: 'lead', kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'claude', model: 'sonnet', instructions: 'SECRET-INSTRUCTIONS stay in Base.' } } });
    await board.base.create({ id: 'scout', kind: 'profile', name: 'Scout', configuration: { agent: { provider: 'codex' } } });
    await board.base.create({ id: 'gem', kind: 'profile', name: 'Gem', configuration: { agent: { provider: 'gemini' } } });
  }
  const app = await startServer({ port: 0, dataDir, executor: null, networkWorker: worker, catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }), ...(machineOptions ? { machineOptions } : {}), ...serverOptions });
  t.after(() => app.close());
  const port = Number(new URL(app.url).port), session = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const owner = (path, method = 'GET', body, headers = {}) => request(port, path, { method, body, headers: { 'X-STE-Token': session, ...headers } });
  const projects = (await app.board.state()).projects.map(project => project.id);
  const ctx = { dataDir, app, port, session, owner, projects, worker };
  ctx.register = async (baseResourceId, extra = {}) => {
    const { json: list } = await owner('/api/network/agents');
    const found = list.agents.find(agent => agent.baseResourceId === baseResourceId);
    if (found) return found;
    const answer = await owner('/api/network/agents', 'POST', { baseResourceId, expectedRevision: list.revision, ...extra });
    assert.equal(answer.status, 200, answer.text);
    return answer.json.agent;
  };
  ctx.client = async (scopes, extra = {}) => {
    const answer = await owner('/api/network/clients', 'POST', { name: 'Test client', scopes: { permissions: ALL, ...scopes }, ...extra });
    assert.equal(answer.status, 201, answer.text);
    return answer.json;
  };
  ctx.on = async () => {
    const answer = await owner('/api/network/listener', 'PATCH', { enabled: true, port: 0 });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.listener.listening, true, answer.text);
    ctx.machinePort = Number(new URL(answer.json.listener.url).port);
    return ctx.machinePort;
  };
  ctx.machine = (token, path, { method = 'GET', body, headers = {}, ...rest } = {}) => request(ctx.machinePort, `/machine/v1${path}`, { method, body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...rest });
  return ctx;
}
