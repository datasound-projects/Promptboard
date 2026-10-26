/**
 * A deterministic stand-in for a Network job worker (the interface of src/network/jobs.mjs): no process, no CLI, no
 * network. `mode: 'complete'` runs every attempt through launching → spawned → a structured result at once;
 * `mode: 'manual'` hands each started attempt to the test (`worker.attempts`, `worker.next()`), which drives it with the
 * ownership's own calls and ends the worker's part with `entry.end()`. Its "process" is a flag, so a test can see
 * whether it was stopped (`killed`). `endOnCancel: false` keeps the worker's part open after a cancel, as a worker that
 * still delivers the result it had when the stop came. `active`/`maxActive` count attempts the worker is running.
 */
export function fakeWorker({ mode = 'complete', text = job => `Report for: ${job.request.input.text}`, refuse = null, pid = 4242, endOnCancel = true } = {}) {
  const waiting = [];
  const worker = {
    claims: [], starts: [], cancels: [], attempts: new Map(), active: 0, maxActive: 0,
    async claim(job, own) {
      worker.claims.push(own.attemptId);
      if (refuse) throw refuse;
    },
    async start(job, own) {
      worker.starts.push(own.attemptId);
      worker.maxActive = Math.max(worker.maxActive, ++worker.active);
      const entry = { own, job, process: 'none', killed: false };
      worker.attempts.set(own.attemptId, entry);
      const done = new Promise(resolve => { entry.end = resolve; });
      waiting.shift()?.(entry);
      try {
        if (mode === 'manual') return await done;
        await own.launching();
        entry.process = 'running';
        try { await own.spawned({ pid }); } catch (error) { entry.process = 'ended'; entry.killed = true; throw error; }
        entry.process = 'ended';
        return await own.finish({ status: 'completed', exitCode: 0, result: { text: text(job) } });
      } finally { worker.active--; }
    },
    async cancel(own) {
      worker.cancels.push(own.attemptId);
      const entry = worker.attempts.get(own.attemptId);
      if (!entry) return;
      if (entry.process === 'running') entry.killed = true;
      entry.process = 'ended';
      if (endOnCancel) entry.end();
    },
    getStatus(own) { return { process: worker.attempts.get(own.attemptId)?.process ?? 'none' }; },
    /** The next attempt the engine starts (call it before the start happens); rejects when none starts within `ms`. */
    next(ms = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No attempt started.')), ms);
        waiting.push(entry => { clearTimeout(timer); resolve(entry); });
      });
    },
  };
  return worker;
}
