/**
 * A mock A2A peer for the federation tests, built from the official `@a2a-js/sdk` 1.3.0 server pieces
 * (DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler) on 127.0.0.1 with port 0. It serves its Agent Card
 * at /.well-known/agent-card.json and JSON-RPC at /a2a, records every request (headers included), and can: require a
 * bearer token, stream (SSE) or not, hold a task open until released, end in any task state, drop its stream after the
 * first event (while the task goes on, so a client must poll), refuse or ignore a cancel, and answer any path with a
 * test's own handler (redirects, oversized or slow bodies). No real network: loopback only.
 */
import http from 'node:http';
import { AgentCard, formatSSEEvent, Role, SSE_HEADERS, TaskState } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, AgentEvent } from '@a2a-js/sdk/server';

const now = () => new Date().toISOString();
const part = value => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const textOf = message => (message?.parts || []).map(item => (item.content?.$case === 'text' ? item.content.value : '')).join('\n');

/**
 * `streaming`, `token` (required bearer value or null), `finish` (a TaskState name, default TASK_STATE_COMPLETED),
 * `answer(input) → text`, `hold` (tasks wait for `peer.release()`), `dropStream` (close the SSE response after the first
 * event), `cancel` ('confirm' | 'refuse' | 'hang'), `card(port)` → extra card fields, `route(req, res, peer)` → true when it
 * answered, `json` (a data part to add to the result).
 */
export async function mockPeer(t, { streaming = false, token = null, finish = 'TASK_STATE_COMPLETED', answer = input => `Remote answer to: ${input}`, hold = false, dropStream = false,
  cancel = 'confirm', card = () => ({}), route = null, json = null, host = '127.0.0.1' } = {}) {
  const peer = { requests: [], held: new Map(), taskIds: [], port: 0 };
  const cardOf = () => ({ name: 'Mock peer', description: 'A test peer built with the official SDK.', version: '1.0.0', provider: undefined,
    supportedInterfaces: [{ url: `http://${host}:${peer.port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
    capabilities: { streaming, pushNotifications: false, extensions: [] }, securitySchemes: token ? { bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'A token', scheme: 'Bearer', bearerFormat: '' } } } } : {},
    securityRequirements: token ? [{ schemes: { bearer: { list: [] } } }] : [], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'answer', name: 'Answer', description: 'Answers a question.', tags: ['test'], examples: [], inputModes: [], outputModes: [], securityRequirements: [] }], signatures: [] });
  const executor = {
    async execute(ctx, bus) {
      peer.taskIds.push(ctx.taskId);
      const base = { taskId: ctx.taskId, contextId: ctx.contextId, metadata: undefined };
      bus.publish(AgentEvent.task({ id: ctx.taskId, contextId: ctx.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() }, artifacts: [], history: [], metadata: undefined }));
      bus.publish(AgentEvent.statusUpdate({ ...base, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now() } }));
      if (hold) {
        const outcome = await new Promise(resolve => peer.held.set(ctx.taskId, resolve));
        if (outcome === 'cancelled') return;
      }
      const input = textOf(ctx.userMessage);
      if (finish === 'TASK_STATE_COMPLETED') {
        bus.publish(AgentEvent.artifactUpdate({ ...base, artifact: { artifactId: 'answer', name: 'answer', description: '', parts: [part(answer(input)), ...(json ? [{ content: { $case: 'data', value: json }, metadata: undefined, filename: '', mediaType: 'application/json' }] : [])], metadata: undefined, extensions: [] }, append: false, lastChunk: true }));
      }
      bus.publish(AgentEvent.statusUpdate({ ...base, status: { state: TaskState[finish] ?? finish, message: finish === 'TASK_STATE_FAILED' ? { messageId: 'm-fail', contextId: ctx.contextId, taskId: ctx.taskId, role: Role.ROLE_AGENT, parts: [part('<b>Remote said no</b>')], metadata: undefined, extensions: [], referenceTaskIds: [] } : undefined, timestamp: now() } }));
      bus.finished();
    },
    async cancelTask(taskId, bus) {
      peer.held.get(taskId)?.('cancelled');
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: '', metadata: undefined, status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: now() } }));
      bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(cardOf(), new InMemoryTaskStore(), executor);
  // The card the handler holds is only for its own checks; the served card is built per request (it knows the port).
  const rpc = new JsonRpcTransportHandler(handler);
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    peer.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (route && await route(req, res, peer, body)) return;
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...AgentCard.toJSON(cardOf()), ...card(peer.port) })); return; }
    if (req.method !== 'POST' || req.url !== '/a2a') { res.writeHead(404); res.end(); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    const parsed = JSON.parse(body);
    if (parsed.method === 'CancelTask' && cancel !== 'confirm') {
      if (cancel === 'hang') return; // Never answers.
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32002, message: 'Task not cancelable' } })); return;
    }
    const out = await rpc.handle(parsed, new ServerCallContext({ user: { isAuthenticated: true, userName: 'caller' } }));
    if (out && typeof out[Symbol.asyncIterator] === 'function') {
      res.writeHead(200, SSE_HEADERS);
      let sent = 0, dropping = null;
      for await (const event of out) { // Drained to the end, so the task store sees every event even after a drop.
        if (dropStream && sent >= 1) { dropping ??= new Promise(resolve => setTimeout(() => { res.destroy(); resolve(); }, 100)); continue; } // The connection breaks after the first event arrived.
        res.write(formatSSEEvent(event)); sent++;
      }
      await dropping;
      if (!res.destroyed) res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  peer.port = server.address().port;
  peer.url = `http://${host}:${peer.port}`;
  peer.cardUrl = `${peer.url}/.well-known/agent-card.json`;
  peer.release = id => { for (const [taskId, resolve] of peer.held) if (!id || id === taskId) { peer.held.delete(taskId); resolve('done'); } };
  peer.rpc = method => peer.requests.filter(item => item.url === '/a2a').map(item => JSON.parse(item.body)).filter(item => item.method === method);
  t.after(() => { peer.release(); server.closeAllConnections?.(); return new Promise(resolve => server.close(() => resolve())); });
  return peer;
}
