/** Execution primitives. The move journal must persist intent before calling these. */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { normalizePipelineAutomations } from './pipeline-config.mjs';
import { pipelineScriptEnvironment, pipelineTemplateVariables, renderPipelineTemplate } from './pipeline-templates.mjs';
import { makeTempDir, removeTempDir, trackChild } from './providers.mjs';
import { abortable } from './cancellation.mjs';

export class PipelineActionError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const fail = (message, code) => { throw new PipelineActionError(message, code); };
const check = signal => { if (signal.aborted) throw signal.reason; };
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function retryDelay(header, attempt) {
  if (header) {
    const value = header.trim(), seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
    const date = seconds === null ? Date.parse(value) : null;
    if (seconds !== null && Number.isFinite(seconds)) return Math.min(seconds * 1000, 30000);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30000));
  }
  return attempt * 500;
}

export class PipelineActions {
  constructor({ fetcher = globalThis.fetch, notifier = null } = {}) {
    this.fetcher = fetcher; this.notifier = notifier; this.jobs = new Map(); this.stopping = false;
  }

  async run(input, context, { signal = null, timeoutMs = null } = {}) {
    if (this.stopping) fail('Automation execution is shutting down.', 'ACTION_SHUTTING_DOWN');
    const row = normalizePipelineAutomations({ onEnter: [input] }).onEnter[0];
    if (!row.enabled) return { status: 'skipped', reason: 'This automation is disabled.' };
    if (row.type === 'send_message') fail('Agent messages require the session delivery scheduler.', 'MESSAGE_SCHEDULER_REQUIRED');
    if (!context || typeof context.actionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(context.actionId)) fail('An action needs its persisted run ID.', 'ACTION_CONTEXT_INVALID');
    if (!['enter', 'exit'].includes(context.move?.trigger)) fail('An action needs its recorded arrival or departure.', 'ACTION_CONTEXT_INVALID');
    if (row.type === 'run_script' && (typeof context.cwd !== 'string' || !isAbsolute(context.cwd) || context.cwd.includes('\0'))) fail('A script needs a verified absolute working directory.', 'ACTION_CONTEXT_INVALID');
    if (this.jobs.has(context.actionId)) fail('This automation is already running.', 'ACTION_ACTIVE');
    const variables = pipelineTemplateVariables(context);
    const budget = row.type === 'run_script' ? row.timeoutMinutes * 60000 : row.type === 'webhook' ? 30000 : 5000;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) fail('Use a positive remaining automation budget.', 'ACTION_CONTEXT_INVALID');
    const controller = new AbortController(), deadline = new AbortController();
    const combined = AbortSignal.any([controller.signal, deadline.signal, ...(signal ? [signal] : [])]);
    // Keep an accepted callback alive until its bounded outcome can be saved.
    // AbortSignal.timeout alone does not keep Node 22's event loop running.
    const deadlineTimer = setTimeout(() => deadline.abort(new DOMException('Automation budget expired.', 'TimeoutError')), Math.ceil(Math.min(timeoutMs ?? budget, budget)));
    const startedAt = Date.now();
    const job = { controller, promise: null }; this.jobs.set(context.actionId, job);
    job.promise = Promise.resolve().then(async () => {
      check(combined);
      if (row.type === 'run_script') return this.#script(row, context, variables, combined);
      if (row.type === 'webhook') return this.#webhook(row, context, variables, combined);
      if (!this.notifier) return { status: 'unconfirmed', reason: 'No notification receiver is connected.' };
      const result = await abortable(Promise.resolve().then(() => { check(combined); return this.notifier({ id: context.actionId,
        projectId: context.project?.id, taskId: context.task.id,
        title: renderPipelineTemplate(row.title, variables).slice(0, 500), body: renderPipelineTemplate(row.body, variables).slice(0, 4000) }, { signal: combined }); }), combined);
      return result?.confirmed === true ? { status: 'succeeded' } : { status: 'unconfirmed', reason: 'Notification delivery was not confirmed.' };
    }).catch(error => {
      if (combined.aborted) return { status: combined.reason?.name === 'TimeoutError' ? 'timed_out' : 'cancelled',
        errorCode: combined.reason?.name === 'TimeoutError' ? 'ACTION_TIMEOUT' : 'ACTION_CANCELLED', reason: 'The automation was stopped before its outcome was confirmed.' };
      return { status: 'failed', errorCode: error instanceof PipelineActionError ? error.code : 'ACTION_FAILED',
        reason: error instanceof PipelineActionError ? error.message : 'The automation could not finish. Check its configuration and retry explicitly.' };
    }).then(result => ({ ...result, durationMs: Date.now() - startedAt })).finally(() => {
      clearTimeout(deadlineTimer);
      job.finished = true;
      // Keep ownership of a process whose termination was not confirmed. It
      // can still be stopped explicitly or retried during shutdown.
      if (!job.child?.pid || job.child.exitCode !== null || job.child.signalCode !== null) this.jobs.delete(context.actionId);
    });
    return job.promise;
  }

  cancel(actionId) { const job = this.jobs.get(actionId); job?.controller.abort('cancelled'); if (job?.stopRetry) void job.stopRetry(); return Boolean(job); }
  async stop(actionId) {
    const job = this.jobs.get(actionId);
    if (!job) return true;
    job.controller.abort('cancelled');
    await job.promise;
    await job.stopRetry?.();
    return !this.jobs.has(actionId);
  }
  async shutdown() {
    this.stopping = true;
    for (const job of this.jobs.values()) job.controller.abort('shutdown');
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    await Promise.allSettled([...this.jobs.values()].map(job => job.stopRetry?.()));
  }

  async #script(row, context, variables, signal) {
    const directory = await makeTempDir('promptboard-script-');
    try {
      const windows = process.platform === 'win32', file = join(directory, windows ? 'action.ps1' : 'action.sh');
      await writeFile(file, `${windows ? '\uFEFF' : ''}${renderPipelineTemplate(row.script, variables, 'script')}\n`, { mode: 0o600, flag: 'wx' });
      check(signal);
      const command = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
      const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file] : [file];
      return await new Promise(resolve => {
        const environment = { ...process.env };
        // Windows keys are case-insensitive. Do not let a differently cased
        // inherited value shadow the exact per-task environment.
        const exactEnvironment = pipelineScriptEnvironment(variables), names = new Set(Object.keys(exactEnvironment));
        for (const key of Object.keys(environment)) if (names.has(key.toUpperCase())) delete environment[key];
        Object.assign(environment, exactEnvironment);
        let child;
        try { child = trackChild(spawn(command, args, { cwd: context.cwd, env: environment, shell: false, windowsHide: true, detached: !windows, stdio: 'ignore' })); }
        catch { resolve({ status: 'failed', errorCode: 'SCRIPT_SPAWN_FAILED', reason: 'The script shell could not start.' }); return; }
        const owned = this.jobs.get(context.actionId); owned.child = child;
        child.once('close', () => { owned.child = null; if (owned.finished && this.jobs.get(context.actionId) === owned) this.jobs.delete(context.actionId); });
        let settled = false, timer, killing = null, stopFailed = false;
        const kill = () => {
          if (!child.pid || killing) return killing;
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
          stopFailed = false;
          if (!windows) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') stopFailed = true; }
            killing = Promise.resolve().finally(() => { if (stopFailed) killing = null; }); return killing;
          }
          killing = new Promise(done => {
            const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
            let killTimer; const finish = code => { clearTimeout(killTimer); if (code !== 0) stopFailed = true; done(); };
            killer.once('error', () => finish(null)); killer.once('close', finish);
            // Native taskkill startup can be slow on busy Windows hosts. Keep
            // the root alive if cleanup fails, so its tree remains addressable.
            killTimer = setTimeout(() => { try { killer.kill(); } catch {} finish(null); }, 7000);
          }).catch(() => { stopFailed = true; }).finally(() => { if (stopFailed) killing = null; });
          return killing;
        };
        owned.stopRetry = kill;
        const finish = async result => {
          if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (signal.aborted && killing) await killing;
          resolve(stopFailed ? { status: 'failed', errorCode: 'SCRIPT_STOP_FAILED', reason: 'The script process tree could not be confirmed stopped. Check it before retrying.' } : result);
        };
        const abort = () => {
          kill();
          timer = setTimeout(() => { stopFailed = true; void finish({ status: 'failed', errorCode: 'SCRIPT_STOP_FAILED', reason: 'The script did not confirm that it stopped.' }); }, 9500);
        };
        child.once('error', error => { void finish({ status: 'failed', errorCode: error.code === 'E2BIG' ? 'SCRIPT_ENVIRONMENT_LIMIT' : 'SCRIPT_SPAWN_FAILED', reason: error.code === 'E2BIG' ? 'Task metadata exceeds the native process environment limit.' : 'The script shell could not start.' }); });
        child.once('close', (exitCode, terminatedBy) => { void finish(exitCode === 0 && !signal.aborted ? { status: 'succeeded', exitCode: 0 }
          : { status: 'failed', errorCode: 'SCRIPT_FAILED', exitCode, ...(terminatedBy ? { terminatedBy } : {}), reason: `The script exited with ${exitCode ?? terminatedBy ?? 'an unknown outcome'}.` }); });
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      }).then(result => { if (result.errorCode !== 'SCRIPT_STOP_FAILED') check(signal); return result; });
    } finally {
      // A locked temporary file must not erase the execution outcome. Failed
      // cleanup stays in the existing owned-directory registry for shutdown.
      await removeTempDir(directory).catch(() => {});
    }
  }

  async #webhook(row, context, variables, signal) {
    const renderedUrl = renderPipelineTemplate(row.url, variables, 'url');
    if (Buffer.byteLength(renderedUrl) > 8192) fail('The rendered webhook URL exceeds 8 KiB.', 'WEBHOOK_URL_INVALID');
    const url = new URL(renderedUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP or HTTPS URL without embedded credentials.', 'WEBHOOK_URL_INVALID');
    const headers = new Headers({ 'Content-Type': 'application/json', 'Idempotency-Key': context.actionId, 'X-Promptboard-Event': `automation.${context.move.trigger}` });
    for (const [name, template] of Object.entries(row.headers)) {
      const value = renderPipelineTemplate(template, variables);
      if (/[\r\n\0]/.test(value) || Buffer.byteLength(value) > 8192) fail('Rendered webhook headers must be at most 8 KiB without line breaks.', 'WEBHOOK_HEADERS_INVALID');
      headers.set(name, value);
    }
    const pr = context.task.evidence?.pullRequest || context.task.pullRequest || {};
    const payload = { event: `automation.${context.move.trigger}`, trigger: context.move.trigger,
      column: context.move.column, fromColumn: context.move.fromColumn || null, toColumn: context.move.toColumn || null,
      task: { id: context.task.id, number: context.task.number ?? null, title: context.task.title, labels: context.task.labels || [],
        branch: context.task.workspace?.branch || null, prUrl: pr.url || null, prNumber: pr.number ?? null, prState: variables.prState || null },
      project: { id: context.project?.id || null, name: context.project?.name || null } };
    const body = row.method === 'GET' ? undefined : row.body.trim() ? renderPipelineTemplate(row.body, variables, 'json') : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > 2 * 1024 * 1024) fail('The rendered webhook body exceeds 2 MiB.', 'WEBHOOK_BODY_TOO_LARGE');
    for (let attempt = 1; attempt <= 3; attempt++) {
      check(signal);
      if (context.onAttempt) await abortable(Promise.resolve().then(() => { check(signal); return context.onAttempt(attempt); }), signal);
      check(signal); let response;
      try { response = await abortable(this.fetcher(url, { method: row.method, headers, body, signal, redirect: 'manual' }), signal); }
      catch { check(signal); if (attempt === 3) return { status: 'failed', errorCode: 'WEBHOOK_TRANSPORT_FAILED', attempts: attempt, reason: 'The webhook could not be reached after three attempts.' }; await wait(retryDelay(null, attempt), signal); continue; }
      void response.body?.cancel().catch(() => {});
      if (response.ok) return { status: 'succeeded', httpStatus: response.status, attempts: attempt };
      if (![408, 429].includes(response.status) && !(response.status >= 500 && response.status <= 599) || attempt === 3) return { status: 'failed', errorCode: 'WEBHOOK_HTTP_FAILED', httpStatus: response.status, attempts: attempt, reason: `The webhook answered HTTP ${response.status}.` };
      await wait(retryDelay(response.headers.get('retry-after'), attempt), signal);
    }
  }
}
