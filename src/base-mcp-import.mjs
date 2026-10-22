/**
 * Import MCP servers from configurations people already have: Claude Desktop (claude_desktop_config.json), Claude
 * Code (.mcp.json), TRAE, Gemini CLI / Antigravity settings ("mcpServers") and VS Code (.vscode/mcp.json, "servers").
 * Nothing secret is copied: a value in `env` or `headers` becomes an environment-variable reference to set where
 * Promptboard runs, and a command argument that looks like a credential stops that server from being imported.
 * Imported servers start switched off and untrusted, so nothing runs until the person trusts and tests one.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]{0,127})(?::-[^}]*)?\}$|^\$([A-Za-z_][A-Za-z0-9_]{0,127})$/;
// A value that looks like a credential, not a word ("read", "none", "mydb") or a file ("server.js"): it has a digit, or
// eight characters without a dot.
const TOKEN = String.raw`(?=[^\s&#]*\d|[^\s&#.]{8})`;
// Credential shapes in arguments: known token prefixes, key=value with a secret-sounding key, ?key= in a URL, a password
// in a URL (postgresql://user:pw@host) or a secret header ("Authorization: Bearer …"); a $VAR or ${VAR} reference is no
// secret. A pasted configuration was never reviewed, so its import also refuses any long bare token (not an absolute
// path); a typed argument may be a hash.
export const CREDENTIAL_ARG = new RegExp(String.raw`(?:^|[=:])(?:sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza)[A-Za-z0-9_-]{8,}|(?:token|secret|password|api[-_]?key|authorization)=(?!\$)\S|[?&]key=(?!\$)${TOKEN}|:\/\/[^\s/@:]*:(?!\$)[^\s/@]+@|(?:^|=)[\w-]*(?:token|secret|password|api[-_]?key|authorization)\s*:\s*(?!(?:(?:bearer|basic|token)\s+)?\$)(?:(?:bearer|basic|token)\s+)?${TOKEN}`, 'i');
const SECRET_ARG = new RegExp(`${CREDENTIAL_ARG.source}|^(?!/)[A-Za-z0-9+/_-]{40,}={0,2}$`, 'i');
// A secret-sounding flag takes its value from the next argument (--api-key <value>) when that value looks like a token
// (so a switch such as --no-password before "mydb" is no secret); a reference, a path or another flag is none either.
const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization)$/i, NOT_SECRET = /^(?:\$|-|[./~]|[A-Za-z]:[\\/])/, TOKEN_VALUE = /\d|^[^.]{8,}$/;
/** The arguments that look like credentials. */
export const credentialArgs = (args, shape = CREDENTIAL_ARG) => args.filter((arg, index) => shape.test(arg) || (SECRET_FLAG.test(args[index - 1] || '') && !NOT_SECRET.test(arg) && TOKEN_VALUE.test(arg)));
const envName = (...parts) => parts.join('_').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^(\d)/, '_$1').slice(0, 120);

/** Where Claude Desktop keeps its configuration on this computer (documented for macOS and Windows). */
export function claudeDesktopConfigPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** One configured value → an environment reference, and what the person must do for it. */
function reference(server, key, value, environment, header = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = text.match(REFERENCE);
  if (match) { const name = match[1] || match[2]; return { name: key, reference: name, ready: Boolean(environment[name]), note: environment[name] ? '' : `Set ${name} where Promptboard runs.` }; }
  const name = header ? envName('MCP', server, key) : ENV.test(key) ? key : envName('MCP', server, key);
  return { name: key, reference: name, ready: Boolean(environment[name]), copied: false,
    note: `${environment[name] ? `${name} is set where Promptboard runs and will be used.` : `Set ${name} where Promptboard runs${header ? ' to the full header value' : ''}.`} The value in the file is not copied.` };
}

/** The servers in a configuration, as Base would store them, with what needs attention. Throws on unreadable JSON. */
export function parseMcpConfig(text, { environment = process.env, existing = [] } = {}) {
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('This is not valid JSON. Paste the configuration file’s content.'), { code: 'BASE_INVALID_INPUT', status: 400 }); }
  const block = data?.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data?.servers && typeof data.servers === 'object' ? data.servers : null;
  if (!block || Array.isArray(block)) throw Object.assign(new Error('No "mcpServers" (or VS Code "servers") object was found.'), { code: 'BASE_INVALID_INPUT', status: 400 });
  const servers = [];
  for (const [name, entry] of Object.entries(block).slice(0, 100)) {
    const issues = [], server = { name: String(name).slice(0, 120), issues };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { issues.push('Not a server definition.'); servers.push({ ...server, importable: false }); continue; }
    const url = entry.url || entry.httpUrl || entry.serverUrl;
    const type = String(entry.type || entry.transport || (url ? 'http' : 'stdio')).toLowerCase();
    if (type === 'sse') issues.push('Legacy SSE servers are not supported. Use the server’s Streamable HTTP endpoint instead.');
    if (['stdio', 'local'].includes(type) || entry.command) {
      if (typeof entry.command !== 'string' || !entry.command.trim()) issues.push('No command to start the server.');
      const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
      if (credentialArgs(args, SECRET_ARG).length) issues.push('An argument looks like a credential. Move it into an environment variable in the original configuration, then import again.');
      const env = Object.entries(entry.env && typeof entry.env === 'object' ? entry.env : {}).slice(0, 40).map(([key, value]) => reference(server.name, key, value, environment));
      Object.assign(server, { transport: 'stdio', command: String(entry.command || ''), args, env });
    } else if (url) {
      let endpoint = null;
      try { const parsed = new URL(String(url)); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); endpoint = parsed.href; } catch { issues.push('The URL is not an HTTP(S) address without credentials.'); }
      if (endpoint && [...new URL(endpoint).searchParams.keys()].some(key => /token|secret|password|api.?key|authorization|^key$/i.test(key))) issues.push('The URL carries a credential. Use a header with an environment variable instead.');
      const headers = Object.entries(entry.headers && typeof entry.headers === 'object' ? entry.headers : {}).slice(0, 40).map(([key, value]) => reference(server.name, key, value, environment, true));
      Object.assign(server, { transport: 'streamable-http', endpoint, headers });
    } else issues.push('Neither a command nor a URL.');
    const same = existing.find(resource => resource.kind === 'mcp' && (server.transport === 'stdio' ? resource.configuration?.command === server.command && JSON.stringify(resource.configuration?.args || []) === JSON.stringify(server.args) : resource.configuration?.endpoint === server.endpoint));
    if (same) server.duplicateOf = { id: same.id, name: same.name };
    server.importable = !issues.length && !same;
    servers.push(server);
  }
  return { servers };
}

/** A parsed server as a Base MCP definition: off and untrusted until the person reviews it. */
export function mcpResourceFrom(server, source) {
  const refs = list => Object.fromEntries((list || []).map(item => [item.name, item.reference]));
  return { kind: 'mcp', name: server.name, description: `Imported from ${source}. Review the command before trusting it.`, enabled: false, trust: 'untrusted', tags: ['imported'],
    configuration: server.transport === 'stdio' ? { transport: 'stdio', command: server.command, args: server.args, env: refs(server.env) } : { transport: 'streamable-http', endpoint: server.endpoint, headers: refs(server.headers) } };
}

/** Read a known configuration file on this computer. */
export async function readMcpSource(source, options = {}) {
  if (source !== 'claude-desktop') throw Object.assign(new Error('Choose Claude Desktop or paste a configuration.'), { code: 'BASE_INVALID_INPUT', status: 400 });
  const path = claudeDesktopConfigPath(options.platform, options.env, options.home);
  try { return { path, text: await readFile(path, 'utf8') }; }
  catch { throw Object.assign(new Error(`No Claude Desktop configuration was found at ${path}.`), { code: 'BASE_NOT_FOUND', status: 404 }); }
}
