/**
 * CLI-managed sign-in. This app never reads, stores, or forwards credentials; it runs
 * fixed, allowlisted CLI commands and protocol methods, verified against official docs
 * and the installed CLIs (see docs/cli-adapters.md).
 */
import { execute, makeTempDir, removeTempDir, resolveExecutable, ProviderError } from './providers.mjs';
import { metadataSession } from './models.mjs';
import { VERSION } from './version.mjs';

// login/logout: 'native' = this app runs the CLI's own flow; 'terminal' = the user runs
// the shown command; 'unsupported' = no documented command. Commands are display text only.
export const AUTH_CAPABILITIES = Object.freeze({
  codex: { status: 'cli', login: 'native', device: true, logout: 'native', loginCommand: 'codex login', deviceCommand: 'codex login --device-auth', logoutCommand: 'codex logout' },
  claude: { status: 'cli', login: 'terminal', device: false, logout: 'native', loginCommand: 'claude auth login', logoutCommand: 'claude auth logout' },
  gemini: { status: 'unsupported', login: 'terminal', device: false, logout: 'unsupported', loginCommand: 'gemini', loginNote: 'Start Gemini CLI and choose “Sign in with Google”.' },
  agy: { status: 'unsupported', login: 'terminal', device: false, logout: 'terminal', loginCommand: 'agy', loginNote: 'Start Antigravity CLI and complete the browser sign-in.', logoutCommand: '/logout', logoutNote: 'Start agy, then type /logout at its prompt.' },
});

const METHOD = /^[A-Za-z0-9._-]{1,40}$/;
const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };

function validate(provider) {
  if (!Object.hasOwn(AUTH_CAPABILITIES, provider)) throw Object.assign(new ProviderError('Choose a valid provider.', 'INVALID_PROVIDER'), { status: 400 });
}

async function executable(provider) {
  const found = await resolveExecutable(provider);
  if (!found) throw Object.assign(new ProviderError('Install this CLI first.', 'NOT_INSTALLED'), { status: 409 });
  return found;
}

async function codexSession(found, transact, options) {
  const cwd = await makeTempDir('ste-auth-');
  try {
    return await metadataSession(found, ['app-server'], cwd, async session => {
      await session.request('initialize', { clientInfo: { name: 'promptboard', version: VERSION } });
      session.send({ method: 'initialized', params: {} });
      return transact(session);
    }, options);
  } finally { await removeTempDir(cwd); }
}

/** Returns { state: 'signed-in'|'signed-out'|'unknown', method? }. Never returns account identity. */
export async function readAuthStatus(provider, { signal } = {}) {
  validate(provider);
  if (AUTH_CAPABILITIES[provider].status !== 'cli') return { state: 'unknown' };
  const found = await executable(provider);
  try {
    if (provider === 'codex') {
      // Codex app-server `account/read`: account is null when signed out.
      const result = await codexSession(found, ({ request }) => request('account/read', { refreshToken: false }), { signal, timeoutMs: 12000 });
      if (result?.account && typeof result.account === 'object') return { state: 'signed-in', method: METHOD.test(result.account.type) ? result.account.type : '' };
      return { state: result?.requiresOpenaiAuth === true ? 'signed-out' : 'unknown' };
    }
    // `claude auth status --json` exits 0 when signed in and 1 when not (documented).
    try {
      const { stdout } = await execute({ command: found.command, args: [...found.prefix, 'auth', 'status', '--json'], signal, timeoutMs: 12000, maxStdout: 64000, maxStderr: 16000 });
      const data = JSON.parse(stdout);
      return { state: data.loggedIn === true ? 'signed-in' : 'unknown', method: METHOD.test(data.authMethod) ? data.authMethod : '' };
    } catch (error) {
      if (error.code === 'CLI_FAILED' && error.details?.exitCode === 1) return { state: 'signed-out' };
      throw error;
    }
  } catch (error) {
    if (error.code === 'ABORTED' || signal?.aborted) throw error;
    return { state: 'unknown' };
  }
}

/**
 * Start a native Codex login through the documented app-server `account/login/start`.
 * Existing credentials are not removed first; the CLI replaces them only on success.
 * `onUpdate` receives public fields only: the https sign-in URL or a device code.
 */
export async function startLogin(provider, { method = 'browser', signal, onUpdate = () => {}, timeoutMs = 600_000 } = {}) {
  validate(provider);
  const capability = AUTH_CAPABILITIES[provider];
  if (capability.login !== 'native' || (method === 'device' && !capability.device) || !['browser', 'device'].includes(method)) {
    throw Object.assign(new ProviderError('This CLI does not support sign-in from this app. Use the terminal command shown.', 'UNSUPPORTED'), { status: 400 });
  }
  const found = await executable(provider);
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  let loginId;
  return codexSession(found, async ({ request, failed }) => {
    const response = await request('account/login/start', { type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
    loginId = typeof response?.loginId === 'string' ? response.loginId : undefined;
    const update = method === 'device'
      ? { verificationUrl: httpsUrl(response?.verificationUrl), userCode: /^[A-Za-z0-9-]{4,24}$/.test(response?.userCode) ? response.userCode : '' }
      : { authUrl: httpsUrl(response?.authUrl) };
    if (!(update.authUrl || (update.verificationUrl && update.userCode))) throw new ProviderError('The CLI did not return a sign-in page.', 'AUTH_FAILED');
    onUpdate(update);
    // Cancellation, timeout, or CLI exit rejects `failed`; the session then stops the app-server,
    // which also stops its local sign-in callback listener.
    const result = await Promise.race([done, failed]);
    if (!result?.success) throw new ProviderError('Sign-in did not complete.', 'AUTH_FAILED');
    return { state: 'signed-in' };
  }, { signal, timeoutMs, onNotification: (name, params) => {
    if (name === 'account/login/completed' && (!params?.loginId || !loginId || params.loginId === loginId)) completed({ success: params?.success === true });
  } });
}

/** Run the CLI's own documented sign-out command. The caller must obtain confirmation. */
export async function logout(provider, { signal } = {}) {
  validate(provider);
  if (AUTH_CAPABILITIES[provider].logout !== 'native') {
    throw Object.assign(new ProviderError('This CLI does not support sign-out from this app.', 'UNSUPPORTED'), { status: 400 });
  }
  const found = await executable(provider);
  const args = provider === 'codex' ? ['logout'] : ['auth', 'logout'];
  const cwd = await makeTempDir('ste-auth-');
  try { await execute({ command: found.command, args: [...found.prefix, ...args], cwd, signal, timeoutMs: 20000, maxStdout: 16000, maxStderr: 16000 }); }
  finally { await removeTempDir(cwd); }
  return { state: 'signed-out' };
}
