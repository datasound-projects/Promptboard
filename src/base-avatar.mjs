/** Explicit image drafts; credentials never enter definitions or diagnostics. */
import { createHash } from 'node:crypto';
const problem = (message, code = 'BASE_AVATAR_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
export const imageModel = () => process.env.PROMPTBOARD_IMAGE_MODEL || 'gpt-image-2.5-flare';
const keyName = () => process.env.PROMPTBOARD_IMAGE_API_KEY_ENV || 'OPENAI_API_KEY';
export function imageAvailability() { const name = keyName(), valid = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name); return { provider: 'OpenAI Images', model: imageModel(), keyEnvironment: valid ? name : 'Invalid environment reference', available: valid && Boolean(process.env[name]) }; }
export function normalizeAvatarImage(value) {
  if (!value || !['image/png', 'image/jpeg'].includes(value.mime) || typeof value.data !== 'string' || value.data.length > 3_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw problem('Avatar must be a bounded PNG or JPEG image.');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data || !(value.mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217)) throw problem('Avatar image data is invalid.');
  return { mime: value.mime, data: value.data, contentHash: createHash('sha256').update(bytes).digest('hex') };
}
export async function generateAvatarImage(prompt, { signal, model = imageModel(), fetcher = fetch, environment = process.env } = {}) {
  const name = keyName(), key = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? environment[name] : null;
  if (!key) throw problem(`Set ${imageAvailability().keyEnvironment} in the server environment to generate illustrated avatars. Coding CLI login does not provide an image API key.`, 'BASE_AVATAR_AUTH_REQUIRED', 409);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]);
  let response;
  try { response = await fetcher('https://api.openai.com/v1/images/generations', { method: 'POST', redirect: 'error', signal: bounded, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt: `Create a distinctive illustrated avatar portrait for a coding agent. Head and shoulders, clear face, simple background, no text or logos. User description: ${prompt}`, n: 1, size: '1024x1024', quality: 'low', output_format: 'jpeg', output_compression: 70 }) }); }
  catch { throw problem(bounded.aborted ? 'Avatar generation was cancelled or timed out.' : 'The image service could not be reached.', bounded.aborted ? 'ABORTED' : 'BASE_AVATAR_NETWORK', 502); }
  if (!response.ok) { await response.body?.cancel(); throw problem('The image service rejected this request. Check image API access, billing, and model availability.', response.status === 401 || response.status === 403 ? 'BASE_AVATAR_AUTH_REQUIRED' : 'BASE_AVATAR_PROVIDER', 502); }
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4_000_000) throw problem('The image response exceeds its size limit.', 'BASE_AVATAR_OUTPUT', 502); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('The image service returned an invalid response.', 'BASE_AVATAR_OUTPUT', 502); }
  return normalizeAvatarImage({ mime: 'image/jpeg', data: data.data?.[0]?.b64_json });
}
export class AvatarJobs {
  constructor({ board, claim, track, imageGenerator = generateAvatarImage }) { Object.assign(this, { board, claim, track, imageGenerator }); this.operations = new Map(); }
  cancel(id) { if (!/^[A-Za-z0-9_-]{8,100}$/.test(id || '')) throw problem('Include the avatar operation ID.'); const controller = this.operations.get(id); controller?.abort(); return { cancelled: Boolean(controller), operationId: id }; }
  close() { for (const controller of this.operations.values()) controller.abort(); }
  async generate(input, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId || '') || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000 || input.prompt.includes('\0')) throw problem('Describe an avatar in 1–2,000 characters and include its operation ID.');
    if (this.operations.has(input.operationId)) throw problem('This avatar operation is already running.', 'BUSY', 409);
    const controller = new AbortController(); this.operations.set(input.operationId, controller);
    const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    let claimed, abortClaim;
    try {
      controller.signal.throwIfAborted();
      if (input.resourceId) { const profile = await this.board.base.detail(input.resourceId); if (profile.kind !== 'profile' || profile.revision !== input.expectedRevision) throw problem('This profile changed. Reload it before generating an avatar.', 'RESOURCE_REVISION_CONFLICT', 409); }
      controller.signal.throwIfAborted(); claimed = await this.claim('avatar', 'openai-images');
      abortClaim = () => claimed.job.controller.abort(controller.signal.reason); controller.signal.addEventListener('abort', abortClaim, { once: true }); if (controller.signal.aborted) abortClaim();
      const model = imageModel(); Object.assign(claimed.job, { stage: 'avatar', operationId: input.operationId }); claimed.job.controller.signal.throwIfAborted();
      const image = normalizeAvatarImage(await this.track(this.imageGenerator(input.prompt, { signal: claimed.job.controller.signal, model })));
      claimed.job.controller.signal.throwIfAborted();
      return { avatar: { version: 2, prompt: input.prompt, model, contentHash: image.contentHash }, image };
    } finally { this.operations.delete(input.operationId); signal?.removeEventListener('abort', abort); if (abortClaim) controller.signal.removeEventListener('abort', abortClaim); claimed?.release(); }
  }
}
