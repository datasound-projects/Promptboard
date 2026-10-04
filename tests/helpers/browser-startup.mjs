import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Cold CI launches can exceed 15s. Port discovery and connection share one 30s
// budget; scenario/assertion deadlines stay unchanged and startup never skips.
export class BrowserStartup {
  constructor(chrome, profile, { timeout = 30000 } = {}) {
    this.chrome = chrome; this.profile = profile; this.timeout = timeout;
    this.controller = new AbortController(); this.diagnostics = '';
    this.error = error => { this.controller.abort(error); };
    this.stderr = chunk => { this.diagnostics = (this.diagnostics + chunk.toString('utf8')).slice(-2048); };
    chrome.on('error', this.error); chrome.stderr?.on('data', this.stderr);
    this.timer = setTimeout(() => this.controller.abort(this.failure(`Chrome startup exceeded ${timeout}ms.`)), timeout);
  }

  failure(message) {
    const diagnostic = this.diagnostics.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').trim().slice(-1024);
    return new Error(`${message}${diagnostic ? ` Chrome stderr: ${diagnostic}` : ''}`);
  }

  wait(promise) {
    const { signal } = this.controller;
    return new Promise((resolve, reject) => {
      const stopped = () => finish(reject, signal.reason);
      const finish = (callback, value) => { signal.removeEventListener('abort', stopped); callback(value); };
      signal.addEventListener('abort', stopped, { once: true });
      Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
      if (signal.aborted) stopped();
    });
  }

  async port() {
    for (;;) {
      this.controller.signal.throwIfAborted();
      const value = (await this.wait(readFile(join(this.profile, 'DevToolsActivePort'), 'utf8').catch(() => ''))).split('\n')[0].trim();
      if (/^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535) return Number(value);
      if (this.chrome.exitCode !== null || this.chrome.signalCode !== null) throw this.failure('Chrome exited before DevTools became available.');
      await delay(100, undefined, { signal: this.controller.signal }).catch(() => this.controller.signal.throwIfAborted());
    }
  }

  close() { clearTimeout(this.timer); this.chrome.off('error', this.error); this.chrome.stderr?.off('data', this.stderr); }
}
