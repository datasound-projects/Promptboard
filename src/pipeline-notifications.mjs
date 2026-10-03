/** One browser receiver per alert. A transport write is never display proof. */
import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const validId = value => typeof value === 'string' && ID.test(value);
export class NotificationError extends Error {
  constructor(message, code = 'NOTIFICATION_INVALID', status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = () => { throw new NotificationError('Use valid notification receiver and receipt fields.'); };
const messageOf = input => {
  if (!input || ![input.id, input.taskId, input.projectId].every(validId)
    || typeof input.title !== 'string' || input.title.length > 500 || typeof input.body !== 'string' || input.body.length > 4000) fail();
  return Object.freeze({ id: input.id, taskId: input.taskId, projectId: input.projectId, title: input.title, body: input.body });
};

export class PipelineNotifications {
  constructor() { this.clients = new Map(); this.pending = new Map(); this.seen = new Set(); this.stopping = false; }

  connect(clientId, { send, close = () => {} }) {
    if (this.stopping) throw new NotificationError('Notification reception is stopping.', 'NOTIFICATION_STOPPING', 409);
    if (!validId(clientId) || typeof send !== 'function' || typeof close !== 'function') fail();
    const previous = this.clients.get(clientId);
    if (previous) this.disconnect(previous);
    if (this.clients.size >= 8) throw new NotificationError('Eight browser notification receivers are already connected.', 'NOTIFICATION_RECEIVER_LIMIT', 409);
    const client = { clientId, lease: randomUUID(), send, close, closed: false };
    this.clients.set(clientId, client);
    try { Promise.resolve(send({ type: 'ready', clientId, lease: client.lease })).catch(() => this.disconnect(client)); }
    catch { this.disconnect(client); throw new NotificationError('The browser receiver could not connect.', 'NOTIFICATION_RECEIVER_LOST', 409); }
    return client;
  }

  disconnect(client) {
    if (!client || client.closed || this.clients.get(client.clientId) !== client) return false;
    client.closed = true; this.clients.delete(client.clientId);
    for (const job of this.pending.values()) if (job.client === client) job.finish({ confirmed: false, reason: 'receiver_lost' });
    try { client.close(); } catch {}
    return true;
  }

  deliver(input, { signal = null, timeoutMs = 5000 } = {}) {
    let message;
    try { message = messageOf(input); }
    catch (error) { return Promise.reject(error); }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(new NotificationError('Use a notification acknowledgement budget of at most five seconds.'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const fingerprint = JSON.stringify(message), active = this.pending.get(message.id);
    if (active) return active.fingerprint === fingerprint ? active.promise : Promise.resolve({ confirmed: false, reason: 'identity_conflict' });
    if (this.stopping || this.seen.has(message.id) || this.seen.size >= 10000 || this.pending.size >= 128)
      return Promise.resolve({ confirmed: false, reason: 'dispatch_unavailable' });
    this.seen.add(message.id);
    const client = [...this.clients.values()].at(-1);
    if (!client) return Promise.resolve({ confirmed: false, reason: 'receiver_unavailable' });
    const receipt = randomUUID(), job = { client, receipt, fingerprint, finished: false, promise: null, finish: null };
    job.promise = new Promise((resolve, reject) => {
      const cancelDisplay = () => {
        if (!client.closed) try { Promise.resolve(client.send({ type: 'cancel', id: message.id, receipt })).catch(() => {}); } catch {}
      };
      const abort = () => job.finish(null, signal.reason ?? new DOMException('Notification stopped.', 'AbortError'));
      const timer = setTimeout(() => job.finish({ confirmed: false, reason: 'acknowledgement_timeout' }), Math.ceil(timeoutMs));
      job.finish = (result, error = null) => {
        if (job.finished) return;
        job.finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (this.pending.get(message.id) === job) this.pending.delete(message.id);
        if (!result?.confirmed) cancelDisplay();
        if (result === null) reject(error); else resolve(result);
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    this.pending.set(message.id, job); // Immediate acknowledgements belong to this exact grant.
    if (signal?.aborted) job.finish(null, signal.reason ?? new DOMException('Notification stopped.', 'AbortError'));
    if (!job.finished) try {
      Promise.resolve(client.send({ type: 'notification', lease: client.lease, receipt, ...message }))
        .catch(() => job.finish({ confirmed: false, reason: 'receiver_lost' }));
    } catch { job.finish({ confirmed: false, reason: 'receiver_lost' }); }
    return job.promise;
  }

  acknowledge({ clientId, lease, id, receipt, status } = {}) {
    if (![clientId, lease, id, receipt].every(validId) || !['shown', 'failed', 'closed'].includes(status)) fail();
    const client = this.clients.get(clientId), job = this.pending.get(id);
    if (!client || client.lease !== lease || client.closed || !job || job.client !== client || job.receipt !== receipt || job.finished) return { accepted: false };
    job.finish({ confirmed: status === 'shown', ...(status === 'shown' ? {} : { reason: 'display_unconfirmed' }) });
    return { accepted: true };
  }

  close() {
    this.stopping = true;
    for (const client of [...this.clients.values()]) this.disconnect(client);
  }
}
