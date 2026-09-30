// Minimal Chrome DevTools Protocol driver for real-browser tests (no extra dependencies).
// Launches a headless Chrome/Chromium with a throwaway profile. Returns null when no
// browser is installed, so callers can skip.
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
};

export async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const path of CANDIDATES[process.platform] || []) if (await access(path).then(() => true, () => false)) return path;
  return null;
}

export async function launch({ width = 1280, height = 900 } = {}) {
  const binary = await findChrome();
  if (!binary || typeof WebSocket !== 'function') return null;
  const profile = await mkdtemp(join(tmpdir(), 'pb-chrome-'));
  const chrome = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', `--window-size=${width},${height}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (const end = Date.now() + 15000; !port && Date.now() < end;) {
    port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
    if (!port) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!port) { chrome.kill('SIGKILL'); await rm(profile, { recursive: true, force: true }); return null; }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const waiting = new Map(), listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) { const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
    else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { id++; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const consoleMessages = [];
  listeners.add(message => {
    if (message.method === 'Runtime.consoleAPICalled') consoleMessages.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    if (message.method === 'Log.entryAdded') consoleMessages.push(message.params.entry.text);
    if (message.method === 'Runtime.exceptionThrown') consoleMessages.push(`EXCEPTION ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  });
  const browser = {
    send, consoleMessages,
    /** Listen to DevTools events (for example Page.screencastFrame). Returns a function that stops listening. */
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async goto(url) {
      const loaded = new Promise(resolve => { const listener = message => { if (message.method === 'Page.loadEventFired') { listeners.delete(listener); resolve(); } }; listeners.add(listener); });
      await send('Page.navigate', { url });
      await loaded;
    },
    async reload() {
      const loaded = new Promise(resolve => { const listener = message => { if (message.method === 'Page.loadEventFired') { listeners.delete(listener); resolve(); } }; listeners.add(listener); });
      await send('Page.reload', { ignoreCache: true });
      await loaded;
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async until(expression, label, ms = 10000) {
      for (const end = Date.now() + ms; ;) {
        const value = await browser.eval(`return (${expression});`).catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error(`Timed out in the browser: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    },
    async type(text) { for (const char of text) { await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char }); } },
    async key(key, code = key, keyCode = 13) { await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); },
    async click(x, y) { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); },
    async resize(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); },
    async screenshot() { return Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'); },
    async close() { try { socket.close(); } catch {} chrome.kill('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 200)); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
  return browser;
}
