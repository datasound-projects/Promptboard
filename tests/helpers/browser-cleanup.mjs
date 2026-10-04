import { rm } from 'node:fs/promises';

const lifetimes = new WeakMap();
export function trackChrome(chrome) {
  const lifetime = { closed: false };
  chrome.once('close', () => { lifetime.closed = true; });
  lifetimes.set(chrome, lifetime);
  return chrome;
}

// Only stop the child launched by this fixture. Never remove its profile until
// close confirms that the process has released it; Windows may release locks later.
export async function closeChrome(chrome, profile, { timeout = 5000, remove = rm } = {}) {
  const lifetime = lifetimes.get(chrome);
  if (lifetime ? !lifetime.closed : chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        chrome.off('close', closed);
        error ? reject(error) : resolve();
      };
      const closed = () => finish();
      const timer = setTimeout(() => finish(new Error('Owned Chrome did not close; its profile was retained.')), timeout);
      chrome.once('close', closed);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    });
  }
  await remove(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
