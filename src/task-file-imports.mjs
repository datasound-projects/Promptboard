/** Explicit, bounded GitHub inline-image capture; no credentials or private hosts. */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isPublicAddress } from './base-context.mjs';
import { TaskFileError, TASK_FILE_LIMITS } from './task-files.mjs';

function assetURL(value) {
  let url; try { url = new URL(value); } catch { throw new TaskFileError('An inline image URL is invalid.', 'TASK_FILE_IMPORT_FAILED'); }
  const allowed = url.hostname === 'github.com' && /^\/user-attachments\/assets\/[a-f0-9-]+$/i.test(url.pathname)
    || ['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !allowed)
    throw new TaskFileError('Inline images must be public GitHub attachments. Import without images and attach other files manually.', 'TASK_FILE_IMPORT_FAILED');
  return url;
}
export function inlineImageURLs(text) {
  const urls = new Set();
  for (const match of text.matchAll(/!\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+"[^"\r\n]*")?\s*\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    urls.add(match[1] || match[2] || match[3]);
    if (urls.size > TASK_FILE_LIMITS.count) throw new TaskFileError('An issue has more than 20 inline images. Import without images.', 'TASK_FILES_LIMIT', 413);
  }
  return [...urls];
}
export async function downloadGitHubImage(value, { signal = AbortSignal.timeout(12000), lookupFn = lookup, requestFn = request } = {}) {
  let url = assetURL(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    let cancel; const addresses = await Promise.race([lookupFn(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { cancel = () => reject(new TaskFileError('Image lookup timed out. Import without images.', 'TASK_FILE_IMPORT_FAILED')); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); })]).finally(() => signal.removeEventListener('abort', cancel)); signal.throwIfAborted();
    if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) throw new TaskFileError('Inline images cannot contact private networks.', 'TASK_FILE_IMPORT_FAILED');
    const address = addresses[0];
    const result = await new Promise((resolve, reject) => {
      const req = requestFn(url, { signal, method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'Promptboard/1' },
        lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return res.headers.location ? resolve({ redirect: res.headers.location }) : reject(new TaskFileError('An image redirect is invalid.', 'TASK_FILE_IMPORT_FAILED')); }
        const type = String(res.headers['content-type'] || '').split(';')[0].toLowerCase(), extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
        if (res.statusCode !== 200 || !extension) { res.resume(); reject(new TaskFileError('A GitHub image is private, unavailable or unsupported. Import without images and attach it manually.', 'TASK_FILE_IMPORT_FAILED')); return; }
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > TASK_FILE_LIMITS.bytes) req.destroy(new TaskFileError('An image exceeds 4 MiB. Import without images.', 'TASK_FILES_LIMIT', 413)); else chunks.push(chunk); });
        res.on('end', () => resolve({ name: `github-image-${url.pathname.split('/').at(-1).replace(/[^a-z0-9-]/gi, '').slice(0, 70) || 'attachment'}.${extension}`, base64: Buffer.concat(chunks).toString('base64') }));
        res.on('error', reject); res.on('aborted', () => reject(new TaskFileError('Image download was interrupted.', 'TASK_FILE_IMPORT_FAILED')));
      });
      req.on('error', error => reject(error instanceof TaskFileError ? error : new TaskFileError('Image download failed or timed out. Import without images to continue.', 'TASK_FILE_IMPORT_FAILED'))); req.end();
    });
    if (!result.redirect) return result;
    url = assetURL(new URL(result.redirect, url).href);
  }
  throw new TaskFileError('An image redirected too many times.', 'TASK_FILE_IMPORT_FAILED');
}
