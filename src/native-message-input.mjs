/** Internal transport. Callers still own scheduling, task preflight and durable outcomes. */
import { createHash } from 'node:crypto';
import { NativeMessageReceipts } from './native-message-receipts.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const outcome = (status, reason) => ({ status, confirmed: status === 'confirmed', ...(reason ? { reason } : {}) });
const attempts = new WeakMap();

// Keep UTF-8 code points and each bracketed-paste delimiter in one write.
function chunks(text) {
  const result = []; let value = '', bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character);
    if (bytes + width > 1000) { result.push(value); value = ''; bytes = 0; }
    value += character; bytes += width;
  }
  if (value) result.push(value);
  result[0] = '\x1b[200~' + result[0]; result[result.length - 1] += '\x1b[201~';
  return result;
}

export async function sendOwnedNativeMessage({ session, run, owns, readEvents, grant, submitted, accepted, signal,
  dispatchId, message, mode, timeoutMs = 150000, confirmDelivery = null }) {
  if (!session?.pipeline || !run?.sessionId || !['claude', 'codex', 'gemini'].includes(session.provider)
    || typeof session.proc?.write !== 'function' || typeof session.nativeSessionId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session.nativeSessionId)
    || mode !== 'deferred' || typeof dispatchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(dispatchId)
    || typeof message !== 'string' || !message.isWellFormed() || !message.trim()
    || Buffer.byteLength(message) > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message)
    || message.trimStart().startsWith('/')
    || session.provider === 'codex' && /^<(?:environment_context|user_instructions)>/.test(message)
    || ![owns, readEvents, grant, submitted, accepted].every(callback => typeof callback === 'function')
    || confirmDelivery !== null && typeof confirmDelivery !== 'function'
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000)
    return outcome('unavailable', 'This native input request is unsupported.');
  let custody = attempts.get(session);
  if (!custody) { custody = { active: false, ids: new Set() }; attempts.set(session, custody); }
  if (custody.active || custody.ids.has(dispatchId) || custody.ids.size >= 4096 || session.messageInputUncertain)
    return outcome('unavailable', 'This process cannot grant another native input attempt.');
  custody.active = true; custody.ids.add(dispatchId);
  const started = performance.now(), proc = session.proc, nativeId = session.nativeSessionId;
  let expectedEpoch = session.inputEpoch, reader, ticket, touched = false, queueAccepted = false;
  const expired = () => performance.now() - started >= timeoutMs;
  const owner = () => {
    try { return Boolean(owns() && session.proc === proc && session.nativeSessionId === nativeId && session.inputEpoch === expectedEpoch); }
    catch { return false; }
  };
  const inputReady = () => {
    const terminal = session.terminalInput?.snapshot(), activity = session.activity?.snapshot();
    return owner() && nativeId && !session.paste && !session.initialSubmitPending && !session.initialInputUncertain
      && terminal?.bracketedPaste === true && !terminal.controlPending && !terminal.closed
      && !terminal.manualInputObserved && activity && !activity.permissionPending && !activity.uncertain
      && activity.phase !== 'ended' && activity.ready;
  };
  const abort = () => signal?.aborted ? outcome('cancelled', 'Native message input was cancelled.')
    : expired() ? outcome(touched ? 'unconfirmed' : 'timed_out', 'Native message delivery was not confirmed within its budget.')
      : !owner() ? outcome('unconfirmed', 'Native input ownership changed. Check the terminal before another request.') : null;
  const write = data => {
    if (!owner()) throw new Error('ownership');
    touched = true; session.inputEpoch++; expectedEpoch = session.inputEpoch; session.activity?.input();
    proc.write(data);
  };
  // Bound callbacks as well as polling. A late persistence acknowledgement can
  // never resume this attempt or cause a write after cancellation/deadline.
  const bounded = callback => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearInterval(timer); fn(value); };
    const timer = setInterval(() => {
      try { if (signal?.aborted || expired() || !owner()) finish(reject, new Error('budget')); }
      catch (error) { finish(reject, error); }
    }, 25);
    Promise.resolve().then(() => {
      if (signal?.aborted || expired() || !owner()) throw new Error('budget');
      return callback();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
  const events = () => bounded(readEvents);
  let proved = false;
  try {
    for (;;) {
      await events(); const stopped = abort(); if (stopped) return stopped;
      if (inputReady()) break;
      await delay(50);
    }
    const path = session.nativeHistoryPath || (session.provider === 'codex' ? session.usage?.tail.path : null);
    if (!path) return outcome('unavailable', 'The owned native history is unavailable.');
    const checkpointEpoch = expectedEpoch;
    reader = new NativeMessageReceipts({ provider: session.provider, nativeSessionId: nativeId, runId: run.id,
      getInputEpoch: () => owner() ? checkpointEpoch : null });
    const baseline = await bounded(() => reader.checkpoint(path));
    if (baseline.status !== 'ready') return outcome('unavailable', 'The owned native history could not supply a checkpoint.');
    ticket = baseline.ticket;
    const scope = { dispatchId, provider: session.provider, sessionId: run.sessionId, runId: run.id, mode,
      messageHash: createHash('sha256').update(message).digest('hex') };
    const stoppedBeforeGrant = abort(); if (stoppedBeforeGrant) return stoppedBeforeGrant;
    if (await bounded(() => grant(Object.freeze(scope))) !== true) return outcome('unconfirmed', 'The durable native input grant was not acknowledged.');
    await events(); const stopped = abort(); if (stopped) return stopped;
    if (!inputReady()) return outcome('unconfirmed', 'Native input changed before dispatch. No message was submitted.');
    session.messageInputPending = true;
    const lifecycle = session.messageLifecycleEpoch;
    const pasteOwned = () => {
      const terminal = session.terminalInput?.snapshot(), activity = session.activity?.snapshot();
      return owner() && session.messageLifecycleEpoch === lifecycle && terminal?.bracketedPaste === true
        && !terminal.controlPending && !terminal.closed && !terminal.manualInputObserved
        && activity && !activity.permissionPending && !activity.uncertain && activity.phase !== 'ended';
    };
    for (const chunk of chunks(message)) {
      await events(); const stopped = abort(); if (stopped) return stopped;
      if (!pasteOwned())
        return outcome('unconfirmed', 'Native input changed during paste. Check the terminal before submitting.');
      write(chunk);
      await new Promise(resolve => setImmediate(resolve));
    }
    // Separate paste from Enter so the TUI can commit its input state. Output
    // silence is spacing only, never submission or completion evidence.
    const pastedAt = performance.now();
    while (performance.now() - pastedAt < 1000) { const stopped = abort(); if (stopped) return stopped; await delay(25); }
    await events(); const stoppedBeforeEnter = abort(); if (stoppedBeforeEnter) return stoppedBeforeEnter;
    if (!pasteOwned())
      return outcome('unconfirmed', 'Native input changed before Enter. Check the terminal before submitting.');
    write('\r');
    if (await bounded(submitted) !== true) return outcome('unconfirmed', 'The durable submission marker was not acknowledged.');
    for (;;) {
      await events(); const stopped = abort(); if (stopped) return stopped;
      const proof = await bounded(() => reader.verify(ticket, message));
      const stoppedAfterProof = abort(); if (stoppedAfterProof) return stoppedAfterProof;
      if (proof.status === 'confirmed') {
        if (confirmDelivery && await bounded(confirmDelivery) !== true)
          return outcome('unconfirmed', 'The durable native confirmation was not acknowledged. No input will be retried.');
        const stoppedAfterSave = abort(); if (stoppedAfterSave) return stoppedAfterSave;
        proved = true; return outcome('confirmed');
      }
      if (proof.status === 'accepted' && !queueAccepted) {
        if (await bounded(accepted) !== true) return outcome('unconfirmed', 'The native queue receipt was not acknowledged.');
        queueAccepted = true;
      } else if (proof.status === 'uncertain') return outcome('unconfirmed', 'Native confirmation became uncertain. No input will be retried.');
      await delay(50);
    }
  } catch {
    return abort() || outcome('unconfirmed', 'Native message input was not confirmed. Check the terminal; no input will be retried.');
  } finally {
    reader?.close();
    if (touched && !proved) {
      session.messageInputUncertain = true;
      if (session.activity) session.activity.uncertain = true;
    }
    session.messageInputPending = false;
    custody.active = false;
  }
}
