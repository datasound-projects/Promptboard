// Simulated docker client for tests. It is NOT Docker: it records every call and stands in for the few commands
// Promptboard's Docker mode uses. `docker run` of a card agent starts the fake CLI from FAKE_DOCKER_BIN as the
// "container": in the -w folder, with only the -e variables (plus PATH with this node, as the image's node). Its
// state (built images, containers left running) lives in FAKE_DOCKER_STATE.
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_DOCKER_REPORT) appendFileSync(env.FAKE_DOCKER_REPORT, `${JSON.stringify({ args, token: env.CLAUDE_CODE_OAUTH_TOKEN || null })}\n`);
const stateFile = env.FAKE_DOCKER_STATE && join(env.FAKE_DOCKER_STATE, 'state.json');
const read = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { images: [], containers: [] }; } };
const save = state => stateFile && writeFileSync(stateFile, JSON.stringify(state));
const done = (code, out = '') => { if (out) process.stdout.write(out); process.exit(code); };

if (args[0] === 'version') done(env.FAKE_DOCKER_STOPPED ? 1 : 0, env.FAKE_DOCKER_STOPPED ? '' : '29.0.0\n');
if (args[0] === 'image' && args[1] === 'inspect') done(read().images.includes(args.at(-1)) ? 0 : 1, 'sha256:fake\n');
if (args[0] === 'image' && args[1] === 'ls') done(0, read().images.filter(name => name.startsWith(`${args[2]}:`)).map(name => `${name}\n`).join(''));
if (args[0] === 'image' && args[1] === 'rm') { const state = read(); state.images = state.images.filter(name => !args.slice(2).includes(name)); save(state); done(0); }
if (args[0] === 'ps') done(0, read().containers.map(id => `${id}\n`).join(''));
if (args[0] === 'rm') { const state = read(); state.containers = state.containers.filter(id => !args.includes(id)); save(state); done(0); }
if (args[0] === 'build') {
  // Streams a few steps; FAKE_DOCKER_BUILD_MS slows each one so a test can see progress and cancel.
  const tag = args[args.indexOf('-t') + 1], steps = ['Step 1/3 : FROM node:22-bookworm-slim', 'Step 2/3 : RUN apt-get install git', 'Step 3/3 : RUN npm install -g'];
  let n = 0;
  const next = () => {
    if (n < steps.length) { process.stdout.write(`${steps[n++]}\n`); setTimeout(next, Number(env.FAKE_DOCKER_BUILD_MS || 0)); return; }
    if (env.FAKE_DOCKER_BUILD_FAIL) { process.stderr.write('npm ERR! network unavailable\n'); process.exit(1); }
    const state = read(); state.images = [...new Set([...state.images, tag])]; save(state);
    done(0, `Successfully tagged ${tag}\n`);
  };
  next();
} else if (args[0] === 'run') {
  // Options before the image: these take a value; --rm, -it and --init do not.
  const valued = new Set(['--name', '--label', '--user', '-w', '-v', '-e']);
  let at = 1; const options = [];
  while (at < args.length && args[at].startsWith('-')) { if (valued.has(args[at])) { options.push([args[at], args[at + 1]]); at += 2; } else at += 1; }
  const [, command, ...rest] = args.slice(at);
  // The mount check: FAKE_DOCKER_HIDE names a path the "container" cannot see, FAKE_DOCKER_CHECK_FAIL fails to start.
  if (command === 'sh') {
    if (env.FAKE_DOCKER_CHECK_FAIL) done(125);
    if (env.FAKE_DOCKER_HIDE && rest.includes(env.FAKE_DOCKER_HIDE)) done(3, env.FAKE_DOCKER_HIDE);
    done(spawnSync('/bin/sh', rest, { stdio: 'inherit' }).status ?? 1);
  }
  const name = options.find(([flag]) => flag === '--name')?.[1];
  const state = read(); state.containers.push(name); save(state);
  const inside = { PATH: `${dirname(process.execPath)}:${env.PATH}` };
  for (const [flag, value] of options) {
    if (flag !== '-e') continue;
    const equals = value.indexOf('=');
    if (equals > 0) inside[value.slice(0, equals)] = value.slice(equals + 1);
    else if (env[value] !== undefined) inside[value] = env[value];
  }
  for (const [key, value] of Object.entries(env)) if (/^FAKE_(AGENT|CLAUDE)/.test(key)) inside[key] = value; // Test reporting only.
  const child = spawn(join(env.FAKE_DOCKER_BIN, command), rest, { cwd: options.find(([flag]) => flag === '-w')?.[1], env: inside, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { const after = read(); after.containers = after.containers.filter(id => id !== name); save(after); process.exit(code ?? 1); });
} else if (!['version', 'image', 'ps', 'rm'].includes(args[0])) done(2, `fake docker: unsupported ${args[0]}\n`);
