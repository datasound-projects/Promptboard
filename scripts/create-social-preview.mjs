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
  body { background: #f7f6f2; color: #151515; font-family: Arial, Helvetica, sans-serif; }
  main { height: 100%; display: flex; align-items: center; gap: 60px; padding: 64px 72px; }
  .portrait { flex: none; width: 382px; height: 382px; border-radius: 50%; background: #fff; overflow: hidden; }
  .portrait img { display: block; width: 100%; height: 100%; object-fit: contain; }
  .content { flex: 1; }
  h1 { margin: 0; font-size: 68px; line-height: 1.1; letter-spacing: -3px; font-weight: 700; }
  .tagline { margin: 20px 0 0; font-size: 25px; line-height: 1.5; color: #555550; }
  .pages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; margin: 50px 0 0; padding-top: 25px; border-top: 1px solid #d9d8d2; }
  h2 { margin: 0; font-size: 24px; line-height: 1.3; font-weight: 700; }
  .pages p { margin: 9px 0 0; font-size: 19px; color: #65655f; white-space: nowrap; }
  .footer { margin: 44px 0 0; font-size: 16px; color: #777770; }
</style>
<main>
  <div class="portrait"><img src="data:image/png;base64,${logo}" alt="Promptboard mascot"></div>
  <div class="content">
    <h1>Promptboard</h1>
    <p class="tagline">Your local workspace for agentic coding.</p>
    <div class="pages">
      <section><h2>Compose</h2><p>Clear prompts</p></section>
      <section><h2>Kanban</h2><p>Coding tasks</p></section>
      <section><h2>Base</h2><p>Shared resources</p></section>
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
