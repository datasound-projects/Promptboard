import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/markdown-view.js', import.meta.url), 'utf8');

test('hand-typed anchors and links stay under ctx-, so a document can never take over an id of the app', t => {
  const dom = new JSDOM('<main id="origin-view"></main><article id="preview"></article>', { runScripts: 'outside-only' }), win = dom.window;
  t.after(() => win.close());
  win.eval(domSource); win.eval(source);
  const preview = win.document.querySelector('#preview');
  preview.append(win.PromptboardMarkdown.render('[Jump](#origin-view) · [Contents](#ctx-section-plan)\n\n<a id="origin-view"></a>\n## Mine\n\n<a id="ctx-section-plan"></a>\n## Plan\n'));
  assert.equal(win.document.querySelectorAll('#origin-view').length, 1, 'the app keeps its own id');
  assert.deepEqual([...preview.querySelectorAll('h3')].map(node => node.id), ['ctx-origin-view', 'ctx-section-plan']);
  assert.deepEqual([...preview.querySelectorAll('a')].map(node => node.getAttribute('href')), ['#ctx-origin-view', '#ctx-section-plan'], 'links still reach their anchors');
});

test('quotes and lists nest at most 20 levels; deeper text stays as plain text instead of exhausting the stack', t => {
  const dom = new JSDOM('<article id="preview"></article>', { runScripts: 'outside-only' }), win = dom.window;
  t.after(() => win.close());
  win.eval(domSource); win.eval(source);
  const preview = win.document.querySelector('#preview');
  preview.append(win.PromptboardMarkdown.render(`${'>'.repeat(5000)} deep quote`));
  assert.equal(preview.querySelectorAll('blockquote').length, 21);
  assert.equal(preview.querySelector('blockquote:not(:has(blockquote))').textContent, `${'>'.repeat(4979)} deep quote`);
  preview.replaceChildren(win.PromptboardMarkdown.render(Array.from({ length: 100 }, (_, index) => `${' '.repeat(index)}- item ${index}`).join('\n')));
  assert.equal(preview.querySelectorAll('ul').length, 20);
  assert.match(preview.querySelector('li:not(:has(ul))').textContent, /^item 19- item 20- item 21.*- item 99$/);
});
