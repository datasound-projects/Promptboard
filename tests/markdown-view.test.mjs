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

test('a fence with code on its own line (as agents write it) is a paragraph, never an endless loop', t => {
  const dom = new JSDOM('<article id="preview"></article>', { runScripts: 'outside-only' }), win = dom.window;
  t.after(() => win.close());
  win.eval(domSource); win.eval(source);
  const preview = win.document.querySelector('#preview'), started = Date.now();
  preview.append(win.PromptboardMarkdown.render('Run\n```npm test```\nthen deploy\n\n~~~js const a = `x`\nnext'));
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([...preview.querySelectorAll('p')].map(node => node.textContent), ['Run', 'npm testthen deploy', '~~~js const a = xnext']);
});

test('long runs of spaces, backticks, tildes, ** and arrow padding render in linear time, with the output unchanged', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }), win = dom.window;
  t.after(() => win.close());
  win.eval(domSource); win.eval(source);
  const render = text => { const div = win.document.createElement('div'); div.append(win.PromptboardMarkdown.render(text)); return div.innerHTML; };
  // Each took seconds (spaces, **) to minutes (backtick or tilde runs) with the earlier backtracking expressions.
  const slow = ['a | b\n' + ' '.repeat(100000) + 'x', '# a' + ' '.repeat(100000) + 'b', 'x' + '`'.repeat(100000) + 'x', '**a '.repeat(25000),
    '```' + ' '.repeat(100000) + '`', '~'.repeat(100000) + '`', '```mermaid\nflowchart LR\nA -->' + ' '.repeat(100000) + 'B x\n```'];
  for (const text of slow) { const started = Date.now(); render(text); assert.ok(Date.now() - started < 1500, `slow: ${JSON.stringify(text.slice(0, 12))}`); }
  // A code span opened by n backticks closes at the first later run of exactly n, else n-1 of them open it.
  assert.equal(render('``a` and ```b`` c` · **bold *em* x** · **x · *y* · ``x`'), '<p><code>a` and ```b</code> c<code> · **bold *em* x** · **x · *y* · ``x</code></p>');
  assert.equal(render('**x* and **bold *em* x** · *a_b* · **c'), '<p><strong>x* and **bold <em>em</em> x</strong> · *a_b* · **c</p>');
  assert.equal(render('*** x and **x *y* z'), '<p><em>*</em> x and **x <em>y</em> z</p>', 'an unclosed ** is tried as *, then as text');
  assert.equal(render('## Title ##   \n~~~js x\ncode\n~~~\n| a | b |\n|  ---  |  :---:  |\n| 1 | 2 |'),
    '<h3 class="md-heading">Title</h3><pre class="md-code" data-language="js"><code>code</code></pre><div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
});
