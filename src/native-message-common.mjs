/** Helpers shared by the native message transport, dispatch and scheduler. */
export const SCOPE_FIELDS = ['provider', 'sessionId', 'runId', 'mode', 'messageHash'];

/** One delivery scope: provider, logical session, run, mode and exact message hash. */
export const sameScope = (left, right) => SCOPE_FIELDS.every(field => left?.[field] === right?.[field]);

/** Literal bounded text that a CLI cannot read as control input, a slash command or a Codex context block. */
export const nativeMessageText = (message, provider) => typeof message === 'string' && message.isWellFormed() && Boolean(message.trim())
  && Buffer.byteLength(message) <= 65536 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message) && !message.trimStart().startsWith('/')
  && !(provider === 'codex' && /^<(?:environment_context|user_instructions)>/.test(message));

// Bound callbacks as well as polling. A late acknowledgement can never resume
// an attempt after cancellation, its deadline or a change of owner.

/** Settle with the callback, or reject as soon as `stopped()` holds (checked first and every 25 ms). */
export const untilStopped = (stopped, callback) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn, value) => { if (settled) return; settled = true; clearInterval(timer); fn(value); };
  const timer = setInterval(() => { try { if (stopped()) finish(reject, new Error('Native input stopped.')); } catch (error) { finish(reject, error); } }, 25);
  Promise.resolve().then(() => { if (stopped()) throw new Error('Native input stopped.'); return callback(); }).then(value => finish(resolve, value), error => finish(reject, error));
});

/** Settle with the callback, or reject as soon as `signal` aborts. */
export const untilAborted = (signal, callback) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); fn(value); };
  const abort = () => finish(reject, new Error('Native message stopped.'));
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve().then(() => { signal.throwIfAborted(); return callback(); }).then(value => finish(resolve, value), error => finish(reject, error));
  if (signal.aborted) abort();
});

/** A durable save counts only when it acknowledges `true` within its short grace period. */
export const savedWithin = (callback, ms = 1500) => new Promise(resolve => {
  let settled = false;
  const finish = value => { if (settled) return; settled = true; clearTimeout(grace); resolve(value === true); };
  const grace = setTimeout(() => finish(false), ms);
  Promise.resolve().then(callback).then(finish, () => finish(false));
});
