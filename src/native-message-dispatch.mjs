/** Private journal/transport bridge. Board still owns session selection and scheduling. */
import { createHash } from 'node:crypto';

const fields = ['provider', 'sessionId', 'runId', 'mode', 'messageHash'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const same = (left, right) => fields.every(field => left?.[field] === right?.[field]);
const result = (status, reason, blocked = false) => ({ status, confirmed: status === 'confirmed', reason, ...(blocked ? { blocked: true } : {}) });

export class NativeMessageDispatch {
  constructor({ journal, supervisor }) {
    if (!journal || typeof supervisor?.sendNativeMessage !== 'function') throw new TypeError('Use an owned journal and native Supervisor.');
    this.journal = journal; this.supervisor = supervisor; this.jobs = new Map(); this.tails = new Map(); this.blockedQueues = new Set(); this.stopping = false;
  }

  deliver({ key, actionId, message, scope }, { preflight, signal = null, timeoutMs = 150000 } = {}) {
    if (this.stopping || !key || !['projectId', 'taskId', 'transitionId'].every(field => id(key[field])) || !id(actionId)
      || typeof message !== 'string' || !message.isWellFormed() || !message.trim() || Buffer.byteLength(message) > 65536
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message) || message.trimStart().startsWith('/')
      || scope?.provider === 'codex' && /^<(?:environment_context|user_instructions)>/.test(message)
      || scope?.mode !== 'deferred' || !['claude', 'codex', 'gemini'].includes(scope?.provider)
      || !id(scope.sessionId) || !id(scope.runId) || scope.messageHash !== createHash('sha256').update(message).digest('hex')
      || typeof preflight !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000)
      return Promise.resolve(result('unavailable', 'This journaled native request is unsupported.'));
    key = Object.fromEntries(['projectId', 'taskId', 'transitionId'].map(field => [field, key[field]]));
    scope = Object.fromEntries(fields.map(field => [field, scope[field]]));
    const jobId = JSON.stringify([key.projectId, key.taskId, key.transitionId, actionId]), queueId = JSON.stringify([scope.provider, scope.sessionId, scope.runId]);
    if (this.jobs.has(jobId) || this.jobs.size >= 1000 || this.blockedQueues.has(queueId)) return Promise.resolve(result('unavailable', 'This message already has an owner, its queue is blocked or the bounded queue is full.'));
    const controller = new AbortController(), deadline = new AbortController();
    const combined = AbortSignal.any([controller.signal, deadline.signal, ...(signal ? [signal] : [])]), started = performance.now();
    const timer = setTimeout(() => deadline.abort(new DOMException('Native message budget expired.', 'TimeoutError')), Math.ceil(timeoutMs));
    const job = { controller, promise: null, key, actionId, blocked: false }; this.jobs.set(jobId, job);
    const remaining = () => timeoutMs - (performance.now() - started);
    const bounded = callback => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; combined.removeEventListener('abort', abort); fn(value); };
      const abort = () => finish(reject, new Error('Native message cancelled.'));
      combined.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { combined.throwIfAborted(); return callback(); }).then(value => finish(resolve, value), error => finish(reject, error));
      if (combined.aborted) abort();
    });
    const previous = this.tails.get(queueId) || Promise.resolve();
    const save = callback => new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(grace); resolve(value === true); };
      const grace = setTimeout(() => finish(false), 1500);
      Promise.resolve().then(callback).then(finish, () => finish(false));
    });
    job.promise = (async () => {
      let ownsGrant = false, knownQueue = false, nativeStarted = false, confirmedSaved = false;
      try {
        const move = await bounded(() => this.journal.read(key)), action = move?.actions.find(row => row.id === actionId);
        if (move?.ownerPid !== process.pid || action?.status !== 'scheduled' || action.delivery?.status !== 'queued' || !same(action.delivery, scope))
          return result('unavailable', 'The exact queued delivery is unavailable. No input was supplied.');
        knownQueue = true;
        if ((await bounded(() => previous))?.blocked || this.blockedQueues.has(queueId)) throw new Error('prior outcome');
        if (await bounded(preflight) !== true) throw new Error('preflight');
        const grant = await bounded(() => this.journal.startMessageDelivery(key, actionId));
        if (grant?.accepted !== true || !same(grant.delivery, scope)) {
          job.blocked = true;
          return result('unavailable', 'The delivery grant was not acknowledged. No input was supplied.', true);
        }
        ownsGrant = true;
        job.native = this.supervisor.sendNativeMessage(scope.runId, { dispatchId: actionId, message, mode: scope.mode,
          signal: combined, timeoutMs: Math.max(1, remaining()),
          grant: async actual => {
            if (combined.aborted || actual?.dispatchId !== actionId || !same(actual, scope) || nativeStarted || await bounded(preflight) !== true) return false;
            const current = await bounded(() => this.journal.read(key)), saved = current?.actions.find(row => row.id === actionId)?.delivery;
            if (current?.ownerPid !== process.pid || saved?.status !== 'dispatching' || !same(saved, scope) || combined.aborted) return false;
            nativeStarted = true; return true;
          },
          submitted: () => nativeStarted && !combined.aborted ? this.journal.markMessageSubmitted(key, actionId) : false,
          accepted: () => nativeStarted && !combined.aborted ? this.journal.markMessageAccepted(key, actionId) : false,
          confirmDelivery: async () => {
            if (!nativeStarted || combined.aborted) return false;
            confirmedSaved = await this.journal.finishMessageDelivery(key, actionId, { status: 'confirmed', durationMs: Math.round(performance.now() - started) }) === true;
            return confirmedSaved;
          } });
        const delivered = await job.native;
        if (delivered?.confirmed === true && delivered.status === 'confirmed' && confirmedSaved)
          return result('confirmed', 'Exact native input and its durable receipt were confirmed.');
        if (confirmedSaved) { job.blocked = true; return result('unconfirmed', 'The native outcome acknowledgement was lost. No input will be retried.', true); }
        const status = ['cancelled', 'timed_out', 'unconfirmed'].includes(delivered?.status) ? delivered.status : 'failed';
        if (await save(() => this.journal.finishMessageDelivery(key, actionId, { status, reason: 'Native delivery was not confirmed. No input will be retried.' })) !== true) throw new Error('save');
        return result(status, 'Native delivery was not confirmed. No input will be retried.');
      } catch {
        const status = combined.aborted ? combined.reason?.name === 'TimeoutError' ? 'timed_out' : 'cancelled' : 'unconfirmed';
        if (!confirmedSaved && knownQueue && await save(() => ownsGrant
          ? this.journal.finishMessageDelivery(key, actionId, { status, reason: 'Native input stopped without confirmation. No input will be retried.' })
          : this.journal.finishQueuedMessageDelivery(key, actionId, { status, reason: 'Queued input stopped before dispatch. No input was supplied.' })))
          return result(status, 'Native delivery stopped without confirmation. No input will be retried.');
        job.blocked = true;
        return result(status, ownsGrant ? 'Owned delivery stopped without an acknowledged outcome. No input will be retried.'
          : 'Queued delivery stopped before dispatch. It requires durable reconciliation.', true);
      } finally {
        clearTimeout(timer);
        if (job.blocked) this.blockedQueues.add(queueId);
        if (!job.blocked) this.jobs.delete(jobId);
      }
    })();
    this.tails.set(queueId, job.promise);
    job.promise.finally(() => { if (!job.blocked && this.tails.get(queueId) === job.promise) this.tails.delete(queueId); });
    return job.promise;
  }

  cancel(key, actionId) { const job = this.jobs.get(JSON.stringify([key.projectId, key.taskId, key.transitionId, actionId])); job?.controller.abort('Native message stopped.'); return Boolean(job); }
  async shutdown() { this.stopping = true; for (const job of this.jobs.values()) job.controller.abort('shutdown'); await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
