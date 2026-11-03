import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t) {
  const dom = new JSDOM('<dialog open><input><button>Save</button><div role="alert" hidden></div></dialog>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  // jsdom has no layout. Give visible dialog controls a box, including an error once revealed.
  dom.window.Element.prototype.getClientRects = function () { return this.hidden ? [] : [{}]; };
  dom.window.eval(source);
  const dialog = document.querySelector('dialog'), submit = document.querySelector('button'), error = document.querySelector('[role="alert"]'), input = document.querySelector('input');
  dom.window.PromptboardDom.holdFocus(dialog);
  submit.focus();
  const refuse = () => { error.textContent = 'A name is required.'; error.hidden = false; submit.disabled = false; };
  return { document, submit, error, input, refuse };
}

for (const blur of [false, true]) test(`a refused dialog submit focuses its error when disabling the button ${blur ? 'drops' : 'retains'} focus`, async t => {
  const { document, submit, error, refuse } = fixture(t);
  submit.disabled = true;
  if (blur) submit.blur();
  await settle();
  refuse();
  await settle();
  assert.equal(document.activeElement, error);
});

test('a delayed dialog error does not take focus from a field the user moved to', async t => {
  const { document, submit, input, refuse } = fixture(t);
  submit.disabled = true;
  await settle();
  input.focus();
  refuse();
  await settle();
  assert.equal(document.activeElement, input);
});

test('a synchronous refusal focuses its error even when disable and enable share an observer batch', async t => {
  const { document, submit, error, refuse } = fixture(t);
  submit.disabled = true;
  refuse();
  await settle();
  assert.equal(document.activeElement, error);
});
