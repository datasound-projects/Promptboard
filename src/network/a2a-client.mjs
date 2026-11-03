/**
 * Outbound A2A (docs/network/architecture.md §10.4, §11.3, §11.5, §24): the SSRF-guarded fetch every call to a remote peer
 * goes through, the mapping of remote A2A task states to the Network job lifecycle, and the worker that runs a peer job.
 *
 * Every request — the Agent Card preview and every JSON-RPC call of `@a2a-js/sdk` 1.3.0 (`ClientFactory` with
 * `JsonRpcTransportFactory({ fetchImpl })`) — uses `guardedFetch`: https only (plain http only for a "local test peer", and
 * then only to this computer); the origin must be on the peer's allowlist; the host is resolved first and every address
 * checked (public only, unless the peer allows one private address or is a local test peer), then the connection is pinned
 * to the checked address, so a DNS answer that changes between the check and the connect is never used; redirects only
 * within the same origin, each hop resolved and checked again; the credential header only to the endpoint's origin; no
 * userinfo; 10 s to resolve the name and 10 s to connect, 60 s per request (a stream: 60 s without data, and never longer
 * than its attempt), 1 MiB per response (a card 64 KiB, a stream 8 MiB), 1 MiB per request body. A refused answer is closed,
 * never read. No proxy is used: the request has its own agent (`agent: false`), which Node's env-proxy mode never configures.
 *
 * A peer job is a Network job (jobs.mjs) with `sideEffects: 'external_unknown'`: the worker saves `launching` before the
 * first request, `running` with the remote task's ID (an opaque string, kept exactly) once the peer accepted it, follows it
 * by streaming when the card says so (and by polling when the stream ends early) or by polling, and reports only what the
 * protocol says. Nothing about the peer's tools, memory or processes is claimed. A lost stream or poll with no terminal
 * state is `unknown`; cancelling asks the peer and says whether it confirmed.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pipeline, Readable, Transform } from 'node:stream';
import { Role, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2AError } from '@a2a-js/sdk/errors';
import { isPublicAddress } from '../base-context.mjs';
import { privateAddress as privateOrLoopback } from '../remote-access.mjs';
import { fail, NetworkError } from './storage.mjs';

const KIB = 1024;
/** Resource ceilings (architecture §11.3, §11.5); tests lower them. */
export const A2A_LIMITS = Object.freeze({ connectMs: 10_000, requestMs: 60_000, idleMs: 60_000, responseBytes: 1024 * KIB, cardBytes: 64 * KIB, streamBytes: 8 * 1024 * KIB,
  requestBytes: 1024 * KIB, redirects: 3, pollMs: 2000, pollFailures: 3, cancelMs: 10_000, resultBytes: 1024 * KIB, jsonBytes: 64 * KIB, artifacts: 50, parts: 200 });
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Headers only Promptboard sets: a credential is added per hop, and only for the endpoint's origin. */
const STRIPPED = ['authorization', 'cookie', 'proxy-authorization', 'host', 'x-api-key'];
const refuse = (message, code, status = 400) => fail(message, code, status);

const loopbackName = host => host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
/** 127.0.0.0/8 or ::1, in any spelling (an IPv4-mapped one included). */
export function isLoopback(address) {
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1), mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(canonical);
  return canonical === '::1' || Boolean(mapped && parseInt(mapped[1], 16) >> 8 === 127);
}
/** The one private address an owner may allow for a peer: RFC 1918, 100.64.0.0/10 or fc00::/7, never loopback (review 4, P4-6). */
export const privateRange = address => privateOrLoopback(address) && !isLoopback(address);
const sameAddress = (a, b) => isIP(a) && isIP(a) === isIP(b) && (isIP(a) === 4 ? a === b : new URL(`http://[${a}]`).hostname === new URL(`http://[${b}]`).hostname);
/** Whether a resolved address may be contacted under the peer's policy (architecture §11.5). */
export function allowedAddress(address, { localTest = false, privateAddress = null } = {}) {
  if (localTest) return isLoopback(address); // A local test peer reaches this computer only.
  if (privateAddress && privateRange(privateAddress) && sameAddress(address, privateAddress)) return true; // A peer saved with another address never reaches it.
  return isPublicAddress(address);
}

/** An absolute URL a peer may be reached at: https (http only for a local test peer on this computer), no userinfo or fragment. */
export function checkUrl(value, { localTest = false } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { refuse('Use an absolute https:// URL.', 'A2A_URL_INVALID'); }
  if (String(value).length > 2048) refuse('A peer URL holds at most 2,048 characters.', 'A2A_URL_INVALID');
  if (url.username || url.password) refuse('A URL with a user name or password is refused. Name a credential by its environment variable instead.', 'A2A_URL_INVALID');
  if (url.hash) refuse('Remove the #fragment from the URL.', 'A2A_URL_INVALID');
  if (localTest ? ['http:', 'https:'].includes(url.protocol) && loopbackName(url.hostname) : url.protocol === 'https:') return url;
  refuse(localTest ? 'A local test peer is on this computer only: 127.0.0.1, ::1 or localhost.' : 'Remote peers must use https://. Plain http:// is allowed only for a local test peer on this computer.', 'A2A_URL_INSECURE');
}

/** The real connection: node http(s) with the checked address pinned through `lookup`, no agent (no reused socket). */
export function nodeTransport({ url, address, method, headers, body, signal, connectMs, idleMs }) {
  return new Promise((resolve, reject) => {
    let sent = false, connected = false;
    const lost = error => error instanceof NetworkError ? error
      : new NetworkError(signal?.aborted ? 'The request to the peer was cancelled or ran out of time.' : sent ? 'The connection to the peer was lost.' : 'The peer could not be reached.',
        signal?.aborted ? 'PEER_TIMEOUT' : sent ? 'PEER_CONNECTION_LOST' : 'PEER_UNREACHABLE', 502);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, signal, agent: false,
      lookup: (_host, options, callback) => (options?.all ? callback(null, [address]) : callback(null, address.address, address.family)) }, res => {
      res.setTimeout(idleMs, () => res.destroy(new NetworkError('The peer stopped sending data.', 'PEER_TIMEOUT', 504)));
      resolve({ status: res.statusCode, headers: res.headers, body: res });
    });
    const timer = setTimeout(() => { if (!connected) req.destroy(new NetworkError('The peer did not accept the connection in time.', 'PEER_UNREACHABLE', 504)); }, connectMs);
    req.on('socket', socket => socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(timer); }));
    req.setTimeout(idleMs, () => req.destroy(new NetworkError('The peer did not answer in time.', 'PEER_TIMEOUT', 504)));
    req.on('finish', () => { sent = true; });
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(lost(error)));
    req.end(body ?? undefined);
  });
}

/** `promise`, or a rejection after `ms` or once `signal` aborts: a DNS lookup cannot be cancelled, only no longer waited for. */
function within(promise, ms, signal) {
  let timer, stop;
  return Promise.race([promise, new Promise((_, reject) => {
    stop = () => reject(new Error('timed out')); timer = setTimeout(stop, ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  })]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); });
}

/** A body of at most `max` bytes: past it the stream fails with PEER_RESPONSE_TOO_LARGE (so does a slower reader's source). */
function bounded(body, max) {
  let size = 0;
  const limit = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; done(size > max ? new NetworkError(`The peer sent more than ${Math.round(max / KIB)} KiB.`, 'PEER_RESPONSE_TOO_LARGE', 502) : null, chunk); } });
  pipeline(body, limit, () => {});
  return Readable.toWeb(limit);
}

/**
 * A `fetch` for the SDK and the card preview, bound to one peer's policy: `origins` (exact origins it may reach), `localTest`,
 * `privateAddress`, `credential` ({ origin, header, value } or null), `lookup` (dns.promises.lookup), `transport`, `limits`,
 * `maxBytes` (a response ceiling instead of the default), `allowed` (asked before every request: false means trust was withdrawn,
 * and nothing is sent). Non-2xx answers are refused with a fixed code: no remote body is kept.
 */
export function guardedFetch({ origins, localTest = false, privateAddress = null, credential = null, lookup = dnsLookup, transport = nodeTransport, limits = A2A_LIMITS, maxBytes = null, allowed = null }) {
  return async function fetchImpl(input, init = {}) {
    let url = checkUrl(typeof input === 'string' || input instanceof URL ? input : input?.url, { localTest });
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    for (const name of STRIPPED) delete headers[name];
    const method = String(init.method || 'GET').toUpperCase(), body = init.body === undefined || init.body === null ? null : String(init.body);
    if (body !== null && Buffer.byteLength(body) > limits.requestBytes) refuse(`A request to a peer holds at most ${Math.round(limits.requestBytes / KIB)} KiB.`, 'A2A_REQUEST_TOO_LARGE', 413);
    const stream = /text\/event-stream/i.test(headers.accept || '');
    const signal = AbortSignal.any([init.signal, stream ? null : AbortSignal.timeout(limits.requestMs)].filter(Boolean));
    for (let hop = 0; ; hop++) {
      if (allowed && !allowed()) refuse('Trust in this peer was withdrawn, so nothing more is sent to it.', 'PEER_WITHDRAWN', 409);
      if (!origins.has(url.origin)) refuse('This address is not on the peer’s allowlist, so nothing was sent to it.', 'A2A_ORIGIN_REFUSED', 403);
      let addresses;
      try { addresses = await within(lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true }), limits.connectMs, signal); } catch { refuse('The peer’s host name could not be resolved.', 'PEER_UNREACHABLE', 502); }
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !allowedAddress(String(item?.address), { localTest, privateAddress }))) {
        refuse(localTest ? 'A local test peer must resolve to this computer only. Nothing was sent.' : 'The peer’s host resolves to a private, local or reserved address, which is refused. Nothing was sent.', 'A2A_ADDRESS_REFUSED', 403);
      }
      const send = { ...headers, ...(credential && url.origin === credential.origin ? { [credential.header]: credential.value } : {}) };
      const answer = await transport({ url, address: addresses[0], method, headers: send, body, signal, connectMs: limits.connectMs, idleMs: limits.idleMs });
      if (REDIRECTS.has(answer.status)) {
        answer.body?.destroy?.(); // Closed, not drained: a redirect body is never read.
        let next = null;
        try { next = new URL(String(answer.headers.location), url); } catch {}
        if (!next || hop >= limits.redirects) refuse('The peer redirected too often or without a valid target.', 'A2A_REDIRECT_REFUSED', 502);
        // Never to another origin (scheme, host and port): no request, and so no credential, reaches another host.
        if (next.origin !== url.origin) refuse('The peer redirected to another origin. Promptboard follows redirects only within the same origin, so nothing was sent there.', 'A2A_REDIRECT_REFUSED', 502);
        if (!['GET', 'HEAD'].includes(method) && ![307, 308].includes(answer.status)) refuse('The peer redirected a request in a way that would change it. Nothing more was sent.', 'A2A_REDIRECT_REFUSED', 502);
        url = checkUrl(next.href, { localTest });
        continue;
      }
      if (answer.status < 200 || answer.status > 299) {
        answer.body?.destroy?.(); // Closed, not drained: a peer cannot keep a refused answer's download going.
        const [message, code] = [401, 403].includes(answer.status) ? ['The peer refused the credential (or needs one).', 'REMOTE_AUTH'] : answer.status === 404 ? ['The peer has no such address.', 'REMOTE_NOT_FOUND']
          : answer.status === 429 ? ['The peer is busy (too many requests).', 'REMOTE_BUSY'] : answer.status >= 500 ? [`The peer reported a server error (${answer.status}).`, 'REMOTE_SERVER_ERROR'] : [`The peer refused the request (${answer.status}).`, 'REMOTE_REFUSED'];
        refuse(message, code, 502);
      }
      const max = maxBytes ?? (stream ? limits.streamBytes : limits.responseBytes);
      if (Number(answer.headers['content-length']) > max) { answer.body?.destroy?.(); refuse(`The peer sent more than ${Math.round(max / KIB)} KiB.`, 'PEER_RESPONSE_TOO_LARGE', 502); }
      const type = String(answer.headers['content-type'] || '');
      return new Response([204, 205].includes(answer.status) ? null : bounded(answer.body, max), { status: answer.status, headers: type ? { 'content-type': type } : {} });
    }
  };
}

/**
 * A remote A2A task state → what it means for the job (architecture §10.4): still running, or a final report. Interrupted
 * remote states (input or auth required) end the job as failed: Promptboard cannot answer them in this version. Anything
 * the protocol does not define is `unknown`, never success.
 */
export function remoteOutcome(state) {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: case TaskState.TASK_STATE_WORKING: return { status: 'running' };
    case TaskState.TASK_STATE_COMPLETED: return { status: 'completed' };
    case TaskState.TASK_STATE_FAILED: return { status: 'failed', errorCode: 'REMOTE_FAILED', reason: 'The remote agent reported that the task failed.' };
    case TaskState.TASK_STATE_CANCELED: return { status: 'failed', errorCode: 'REMOTE_CANCELLED', reason: 'The remote agent reported that the task was cancelled.' };
    case TaskState.TASK_STATE_REJECTED: return { status: 'failed', errorCode: 'REMOTE_REJECTED', reason: 'The remote agent declined the task.' };
    case TaskState.TASK_STATE_INPUT_REQUIRED: return { status: 'failed', errorCode: 'REMOTE_INPUT_REQUIRED', reason: 'The remote agent asked for more input, which Promptboard cannot send in this version. The remote task may stay open on the peer.' };
    case TaskState.TASK_STATE_AUTH_REQUIRED: return { status: 'failed', errorCode: 'REMOTE_AUTH_REQUIRED', reason: 'The remote agent asked for authentication during the task, which Promptboard cannot give in this version.' };
    default: return { status: 'unknown', errorCode: 'REMOTE_STATE_UNKNOWN', reason: 'The remote agent reported a task state the A2A protocol does not define, so what happened is not known.' };
  }
}

/** The peer card as the SDK's ClientFactory takes it: only the one approved JSON-RPC endpoint and the streaming flag. */
export const clientCard = card => ({ name: card.name, description: card.description, version: card.version, provider: undefined,
  supportedInterfaces: [{ url: card.endpoint.url, protocolBinding: 'JSONRPC', protocolVersion: card.endpoint.protocolVersion, tenant: card.endpoint.tenant }],
  capabilities: { streaming: card.capabilities.streaming, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
  defaultInputModes: [], defaultOutputModes: [], skills: [], signatures: [] });
const textPart = value => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' });
const TASK_ID = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** What the peer has said about its task so far, bounded: the opaque ID, the state, the artifacts' text and json. */
class Remote {
  constructor(limits) { Object.assign(this, { limits, id: null, state: null, message: '', artifacts: new Map(), bytes: 0, files: 0, json: undefined, overflow: false }); }
  #parts(parts) {
    const out = [];
    for (const part of (Array.isArray(parts) ? parts : []).slice(0, this.limits.parts)) {
      const content = part?.content;
      if (content?.$case === 'text' && typeof content.value === 'string') out.push(content.value);
      else if (content?.$case === 'data' && content.value && typeof content.value === 'object') {
        const json = JSON.stringify(content.value);
        if (Buffer.byteLength(json) <= this.limits.jsonBytes) this.json = JSON.parse(json);
      } else if (content?.$case === 'raw' || content?.$case === 'url') this.files++; // Never downloaded or decoded.
    }
    return out;
  }
  artifact(item, append = false) {
    if (!item || typeof item.artifactId !== 'string') return;
    if (!this.artifacts.has(item.artifactId) && this.artifacts.size >= this.limits.artifacts) { this.overflow = true; return; }
    const texts = this.#parts(item.parts), before = append ? this.artifacts.get(item.artifactId) || [] : [];
    this.artifacts.set(item.artifactId, [...before, ...texts]);
    this.bytes = [...this.artifacts.values()].flat().reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (this.bytes > this.limits.resultBytes) this.overflow = true;
  }
  status(status) {
    if (!status) return;
    this.state = status.state;
    const said = this.#parts(status.message?.parts).join('\n').trim();
    if (said) this.message = said.slice(0, this.limits.resultBytes);
  }
  task(task) {
    if (task.artifacts?.length) { this.artifacts.clear(); for (const item of task.artifacts) this.artifact(item); }
    this.status(task.status);
  }
  text() {
    const body = [...this.artifacts.values()].flat().join('\n\n').trim() || this.message.trim();
    return body && this.files ? `${body}\n\n(The remote agent also returned ${this.files} file part${this.files === 1 ? '' : 's'}; Promptboard does not download files.)` : body;
  }
}

/** Fixed reasons for what can go wrong before or during a call; never the peer's own error text. */
const NOT_SENT = new Set(['A2A_URL_INVALID', 'A2A_URL_INSECURE', 'A2A_ORIGIN_REFUSED', 'A2A_ADDRESS_REFUSED', 'A2A_REDIRECT_REFUSED', 'A2A_REQUEST_TOO_LARGE', 'PEER_UNREACHABLE',
  'PEER_WITHDRAWN', 'REMOTE_AUTH', 'REMOTE_NOT_FOUND', 'REMOTE_BUSY', 'REMOTE_REFUSED']);
/** Trust withdrawn while the attempt was open (review 4, P4-2): the remote outcome is not known, so the job ends unknown. */
const WITHDRAWN = { status: 'unknown', errorCode: 'PEER_WITHDRAWN', reason: 'Trust in this peer was withdrawn while the job ran (outbound federation switched off, or the peer switched off, removed or given a new card), so Promptboard stopped and sends it nothing more. If the peer already had the task, it may still do it.' };

export class A2AWorker {
  /** `federation` (a2a-registry.mjs) gives each peer job its approved card and guarded fetch; `limits` and `sleep` are for tests. */
  constructor({ federation, limits = {}, sleep = null }) {
    this.federation = federation; this.limits = { ...A2A_LIMITS, ...limits };
    this.sleep = sleep ?? ((ms, signal) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }));
    federation.onChange?.(() => this.#withdraw());
  }
  #attempts = new Map(); // attemptId → { client, peer, remote, controller, withdrawn }, only while the attempt is open.

  /** Checks before anything is sent: federation on, the peer still trusted with the card the job pinned, its credential set. */
  async claim(job, own) {
    const pinned = job.request.peer, { peer, fetch } = await this.federation.callable(pinned.peerId);
    if (peer.cardSha256 !== pinned.cardSha256) fail('The peer’s card changed after the job was accepted. Nothing was sent: submit the job again.', 'PEER_CHANGED', 409);
    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: fetch })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetch }), clientConfig: { polling: true } });
    const client = await factory.createFromAgentCard(clientCard(peer.card));
    if (!own.signal.aborted) this.#attempts.set(own.attemptId, { client, peer, remote: new Remote(this.limits), process: 'none', controller: new AbortController(), withdrawn: false }); // Stopped meanwhile: nothing kept.
  }
  async start(job, own) {
    const entry = this.#attempts.get(own.attemptId);
    if (!entry) return;
    try { return await this.#run(job, own, entry); }
    finally {
      entry.process = 'ended';
      entry.controller.abort(); // Every request of the attempt ends with it: no stream outlives its job.
      if (!own.signal.aborted) this.#attempts.delete(own.attemptId); // A stopped attempt is forgotten by cancel(), which still needs it.
    }
  }
  /** Ask the peer to cancel its task; answers whether the protocol confirmed it (the engine says so in the job's reason). */
  async cancel(own) {
    const entry = this.#attempts.get(own.attemptId);
    this.#attempts.delete(own.attemptId); // The engine stops an attempt (its signal first), then cancels it: after this nothing of it is kept.
    if (!entry?.remote.id) return { remoteCancel: 'not_sent' };
    try {
      const task = await entry.client.cancelTask({ tenant: '', id: entry.remote.id, metadata: undefined }, { signal: AbortSignal.timeout(this.limits.cancelMs) });
      return { remoteCancel: task?.id === entry.remote.id && task.status?.state === TaskState.TASK_STATE_CANCELED ? 'confirmed' : 'requested' };
    } catch { return { remoteCancel: 'unconfirmed' }; }
  }
  getStatus(own) { return { process: 'none', remoteTaskId: this.#attempts.get(own.attemptId)?.remote.id ?? null }; }
  /** Trust changed (federation.onChange): every open attempt of a peer no longer trusted as its job pinned it stops at once. */
  #withdraw() {
    for (const entry of this.#attempts.values()) if (!entry.withdrawn && !this.federation.trusts(entry.peer.id, entry.peer.cardSha256)) { entry.withdrawn = true; entry.controller.abort(); }
  }

  async #run(job, own, entry) {
    const { request } = job, remote = entry.remote, signal = AbortSignal.any([own.signal, entry.controller.signal]);
    // Stopped: by the engine (cancel, time limit, shutdown), which saves that itself, or because trust was withdrawn.
    const stopped = () => (own.signal.aborted ? undefined : own.finish(WITHDRAWN));
    if (entry.withdrawn) return stopped();
    await own.launching(); // Saved before the first byte leaves: from here the peer may have the task.
    const text = request.instructions ? `Instructions:\n${request.instructions}\n\nInput:\n${request.input.text}` : request.input.text;
    const parts = [textPart(text), ...(request.input.json !== undefined ? [{ content: { $case: 'data', value: request.input.json }, metadata: undefined, filename: '', mediaType: 'application/json' }] : [])];
    // The attempt ID is the message ID, so a peer that deduplicates messages sees one per attempt.
    const params = { tenant: '', message: { messageId: own.attemptId, contextId: '', taskId: '', role: Role.ROLE_USER, parts, metadata: undefined, extensions: [], referenceTaskIds: [] },
      configuration: { acceptedOutputModes: ['text/plain', 'application/json'], taskPushNotificationConfig: undefined, returnImmediately: true }, metadata: undefined };
    try {
      if (entry.peer.card.capabilities.streaming) {
        try {
          for await (const event of entry.client.sendMessageStream(params, { signal })) {
            const end = await this.#apply(own, entry, event?.payload);
            if (end) return own.finish(end);
          }
        } catch (error) {
          if (signal.aborted) return stopped();
          if (!remote.id && (NOT_SENT.has(error?.code) || error instanceof A2AError)) throw error; // Refused: a definite failure, below.
        }
        if (!remote.id) return own.finish({ status: 'unknown', errorCode: 'REMOTE_STREAM_LOST', reason: 'The stream from the remote agent ended before it named a task, so whether it started the work is not known.' });
        own.activity({ kind: 'status', label: 'The stream ended early; following the remote task by polling.' });
      } else {
        const result = await entry.client.sendMessage(params, { signal });
        const end = await this.#apply(own, entry, result && 'messageId' in result ? { $case: 'message', value: result } : { $case: 'task', value: result });
        if (end) return own.finish(end);
      }
      for (let failures = 0; ;) {
        await this.sleep(this.limits.pollMs, signal);
        if (signal.aborted) return stopped();
        let task;
        try { task = await entry.client.getTask({ tenant: '', id: remote.id, historyLength: 0 }, { signal }); failures = 0; } catch (error) {
          if (signal.aborted) return stopped();
          if (++failures >= this.limits.pollFailures) return own.finish({ status: 'unknown', errorCode: error?.code === 'REMOTE_AUTH' ? 'REMOTE_AUTH' : 'REMOTE_UNREACHABLE', reason: `Promptboard lost contact with the remote task (${failures} failed checks in a row), so what it did is not known.` });
          continue;
        }
        const end = await this.#apply(own, entry, { $case: 'task', value: task });
        if (end) return own.finish(end);
      }
    } catch (error) {
      if (signal.aborted) return stopped();
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : null;
      // Refused before anything reached the peer, or refused by it: a definite failure. Anything else may have started work.
      if (!remote.id && (NOT_SENT.has(code) || error instanceof A2AError)) return own.finish({ status: 'failed', errorCode: code || 'REMOTE_ERROR', reason: error instanceof NetworkError ? error.message : 'The remote agent refused the request.' });
      return own.finish({ status: 'unknown', errorCode: code || 'REMOTE_PROTOCOL', reason: `${error instanceof NetworkError ? `${error.message} ` : 'The remote agent’s answer could not be read. '}What it did is not known.` });
    }
  }

  /** One event from the peer (a task, a status or artifact update, or a direct message); answers the final report once there is one. */
  async #apply(own, entry, payload) {
    const remote = entry.remote, value = payload?.value;
    if (!value) return null;
    if (payload.$case === 'message') {
      if (remote.id) return null; // An agent message inside a task: its state still comes from the task.
      remote.status({ state: TaskState.TASK_STATE_COMPLETED, message: value }); // A direct reply ends the exchange (A2A: a Message result).
      await own.spawned({ pid: null });
      return this.#report(remote);
    }
    const taskId = payload.$case === 'task' ? value.id : value.taskId;
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return { status: 'unknown', errorCode: 'REMOTE_PROTOCOL', reason: 'The remote agent sent a task without a usable ID, so it cannot be followed.' };
    if (!remote.id) {
      remote.id = taskId; // Opaque: kept exactly, never parsed, only sent back to the same peer.
      await own.spawned({ pid: null, remoteTaskId: taskId });
    } else if (taskId !== remote.id) return { status: 'unknown', errorCode: 'REMOTE_PROTOCOL', reason: 'The remote agent reported another task than the one it accepted, so nothing it says is used.' };
    const before = remote.state;
    if (payload.$case === 'task') remote.task(value);
    else if (payload.$case === 'statusUpdate') remote.status(value.status);
    else if (payload.$case === 'artifactUpdate') remote.artifact(value.artifact, value.append === true);
    if (remote.overflow) return { status: 'failed', errorCode: 'OUTPUT_LIMIT', reason: 'The remote agent returned more than the 1 MiB result limit (or 50 artifacts), so nothing was kept.' };
    if (remote.state !== before && remote.state !== null) {
      const label = { [TaskState.TASK_STATE_SUBMITTED]: 'The remote agent accepted the task.', [TaskState.TASK_STATE_WORKING]: 'The remote agent reports that it is working.' }[remote.state];
      if (label) try { own.activity({ kind: 'status', label }); } catch {}
    }
    return remoteOutcome(remote.state).status === 'running' || remote.state === null ? null : this.#report(remote);
  }
  #report(remote) {
    const outcome = remoteOutcome(remote.state);
    if (outcome.status !== 'completed') return { ...outcome, sideEffects: 'external_unknown' };
    return { status: 'completed', sideEffects: 'external_unknown', result: { text: remote.text(), ...(remote.json !== undefined ? { json: remote.json } : {}) } };
  }
}
