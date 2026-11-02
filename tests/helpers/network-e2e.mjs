/**
 * Shared pieces of the Task 14 end-to-end tests (tests/network-e2e*.test.mjs): the fake headless CLIs
 * (tests/fixtures/fake-headless-cli.mjs) as the only programs on PATH besides node, the log folder the fakes write one
 * <pid>.json per run into, and a reader of the owner's NDJSON event stream. No real CLI, no network.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const skipFakes = process.platform === 'win32'; // The fakes are scripts with a shebang line.
export const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick()) { const value = await check(); if (value) return value; }
  assert.fail(`timed out: ${label}`);
}

/** PATH becomes a folder holding only `node` and the fake CLIs; FAKE_HEADLESS_LOG a fresh folder. Answers `{ bin, logs, runs() }`. */
export async function installFakeClis(names = ['claude', 'codex', 'gemini']) {
  const bin = await mkdtemp(join(tmpdir(), 'pb-network-e2e-bin-')), logs = await mkdtemp(join(tmpdir(), 'pb-network-e2e-log-'));
  for (const name of names) {
    await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(new URL('../fixtures/fake-headless-cli.mjs', import.meta.url).href)};\n`);
    await chmod(join(bin, name), 0o700);
  }
  await writeFile(join(bin, 'package.json'), '{"type":"module"}');
  await symlink(process.execPath, join(bin, 'node'));
  process.env.PATH = bin; // No real CLI, git or anything else can be found.
  process.env.FAKE_HEADLESS_LOG = logs;
  process.on('exit', () => { for (const dir of [bin, logs]) rmSync(dir, { recursive: true, force: true }); });
  /**
   * Every fake CLI run that got a prompt so far: { cli, args, input, pid, … } (tests/fixtures/fake-headless-cli.mjs). The app's
   * provider detection (`claude --version`, `claude auth status --json`, when a page loads) sends none and is left out.
   */
  const runs = async () => (await Promise.all((await readdir(logs)).filter(name => /^\d+\.json$/.test(name)).map(async name => JSON.parse(await readFile(join(logs, name), 'utf8'))))).filter(run => run.input);
  return { bin, logs, runs };
}

/** The owner's NDJSON event stream from `after`, read as it arrives (what the Activity page follows). */
export function follow(url, token, after) {
  const controller = new AbortController(), events = [];
  let live = false;
  const reading = (async () => {
    const response = await fetch(`${url}/api/network/events/stream?after=${after}`, { headers: { 'X-STE-Token': token }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
        const item = JSON.parse(buffer.slice(0, end));
        if (item.live) live = true; else if (Number.isSafeInteger(item.seq)) events.push(item);
      }
    }
  })().catch(() => {}); // Stopped, or the app closed: the events read so far are what the test checks.
  return { events, live: () => live, last: () => events.at(-1)?.seq ?? after, stop: async () => { controller.abort(); await reading; } };
}
