#!/usr/bin/env node
/** Render the 1280×640 GitHub card with the existing mascot. Requires Chrome. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../tests/helpers/browser.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'pb-social-'));
let browser;
try {
  const logo = (await readFile(join(root, 'docs/logo.png'))).toString('base64');
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Promptboard social preview</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1280px; height: 640px; overflow: hidden; }
  body { background: radial-gradient(900px 520px at 10% -10%, rgb(139 92 246 / .22), transparent 62%), radial-gradient(800px 480px at 100% 0%, rgb(56 189 248 / .1), transparent 58%), linear-gradient(180deg, #0d0d12, #060608); color: #f5f5f7; font-family: Inter, "Helvetica Neue", Arial, sans-serif; }
  main { height: 100%; display: flex; align-items: center; gap: 60px; padding: 64px 72px; }
  .portrait { flex: none; width: 382px; height: 382px; border-radius: 50%; background: #fff; overflow: hidden; box-shadow: 0 0 0 1px rgb(255 255 255 / .12), 0 30px 90px rgb(139 92 246 / .35); }
  .portrait img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .content { flex: 1; }
  h1 { margin: 0; font-size: 68px; line-height: 1.1; letter-spacing: -3px; font-weight: 700; }
  .tagline { margin: 20px 0 0; font-size: 25px; line-height: 1.5; color: #babac3; }
  .pages { display: grid; grid-template-columns: repeat(4, auto); justify-content: space-between; gap: 24px; margin: 50px 0 0; padding-top: 25px; border-top: 1px solid #26262d; }
  h2 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 24px; line-height: 1.3; font-weight: 700; }
  h2::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
  .pages p { margin: 9px 0 0 20px; font-size: 18px; color: #9b9ba6; white-space: nowrap; }
  .footer { margin: 44px 0 0; font-size: 16px; color: #74747f; }
</style>
<main>
  <div class="portrait"><img src="data:image/png;base64,${logo}" alt="Promptboard mascot"></div>
  <div class="content">
    <h1>Promptboard</h1>
    <p class="tagline">Your local workspace for agentic coding.</p>
    <div class="pages">
      <section style="--accent: #a78bfa"><h2>Origin</h2><p>Plan the project</p></section>
      <section style="--accent: #60a5fa"><h2>Compose</h2><p>Clear prompts</p></section>
      <section style="--accent: #34d399"><h2>Kanban</h2><p>Coding tasks</p></section>
      <section style="--accent: #f472b6"><h2>Base</h2><p>Shared resources</p></section>
    </div>
    <p class="footer">Local first · Open source</p>
  </div>
</main></html>`;
  const page = join(work, 'social-preview.html');
  await writeFile(page, html);
  browser = await launch({ width: 1280, height: 640 });
  if (!browser) throw new Error('Chrome was not found.');
  await browser.resize(1280, 640);
  await browser.goto(pathToFileURL(page).href);
  await browser.until('document.images[0].complete && document.images[0].naturalWidth === 480', 'mascot loaded');
  await browser.layout('return document.documentElement.scrollWidth === 1280 && document.documentElement.scrollHeight === 640;');
  const output = join(root, 'docs/social-preview.png');
  await writeFile(output, await browser.screenshot());
  console.log(`Rendered ${output} (1280×640).`);
} finally {
  await browser?.close();
  await rm(work, { recursive: true, force: true });
}
