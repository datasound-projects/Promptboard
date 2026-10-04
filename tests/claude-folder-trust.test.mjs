import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeFolderTrust } from '../scripts/claude-folder-trust.mjs';

const menu = selected => '\x1b[2J\x1b[HAccessing workspace:\r\n/private/disposable\r\n'
  + `${selected === 'no' ? '❯' : ' '} No, exit\r\n${selected === 'yes' ? '❯' : ' '} Yes, I trust this folder\r\nEnter to confirm · Esc to cancel`;
const fixture = t => { const reader = new ClaudeFolderTrust(); t.after(() => reader.close()); return reader; };

test('Claude folder answer waits for a settled screen and confirms only the currently selected Yes', async t => {
  const reader = fixture(t), first = menu('no');
  assert.equal(await reader.observe(first, 0), null);
  assert.equal(await reader.observe(first, 999), null);
  assert.equal(await reader.observe(first, 1000), 'down');
  assert.equal(await reader.observe(first, 2000), null, 'Navigation is never repeated against stale output.');
  const selected = first + menu('yes');
  assert.equal(await reader.observe(selected, 2001), null);
  assert.equal(await reader.observe(selected, 3000), null);
  assert.equal(await reader.observe(selected, 3001), 'confirm');
  assert.equal(await reader.observe(selected, 4001), null, 'Confirmation is consumed once.');
});

test('an ANSI repaint resetting Yes to No cannot confirm the stale affirmative choice', async t => {
  const reader = fixture(t), first = menu('no');
  await reader.observe(first, 0); assert.equal(await reader.observe(first, 1000), 'down');
  const selected = first + menu('yes'); await reader.observe(selected, 1001);
  const reset = selected + menu('no'); await reader.observe(reset, 1100);
  assert.equal(await reader.observe(reset, 2100), null);
  assert.equal(await reader.observe(reset, 10000), null);
  assert.equal(reader.phase, 'selection_sent');
});

test('startup redraws restart settling and unknown or scrolled-away menus cannot grant an answer', async t => {
  const reader = fixture(t), first = menu('no'); await reader.observe(first, 0);
  const redrawn = first + menu('no'); await reader.observe(redrawn, 900);
  assert.equal(await reader.observe(redrawn, 1000), null);
  assert.equal(await reader.observe(redrawn, 1900), 'down');
  const unrelated = redrawn + '\x1b[2J\x1b[HGrant a tool permission?\r\n❯ Yes, I trust this folder';
  await reader.observe(unrelated, 2000); assert.equal(await reader.observe(unrelated, 4000), null);
  const scrolled = unrelated + menu('yes') + '\r\n'.repeat(40);
  await reader.observe(scrolled, 5000); assert.equal(await reader.observe(scrolled, 7000), null);
});

test('truncated or oversized output and closed readers cannot revive a consumed startup answer', async t => {
  for (const invalid of ['changed-prefix', 'x'.repeat(262145)]) {
    const reader = fixture(t); await reader.observe(menu('no'), 0);
    assert.equal(await reader.observe(invalid, 1000), null);
    assert.equal(await reader.observe(menu('yes'), 5000), null);
    assert.equal(reader.phase, 'blocked');
  }
  const reader = fixture(t); reader.close(); assert.equal(await reader.observe(menu('yes'), 5000), null);
});
