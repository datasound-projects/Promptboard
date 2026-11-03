// Network → Federation, and remote peers in Graph and Pipelines, in headless Chrome: light and dark at 1440 and 390 px with
// nothing scrolling sideways; both switches off at first (Add peer disabled); turn outbound on, add a local test peer by its
// card (a mock built with the official @a2a-js/sdk server classes on 127.0.0.1), review its untrusted card as text (its
// markup never becomes HTML), approve it; publish an agent for A2A, turn inbound on and see the card address; create an
// A2A caller and see its token once; the keyboard (Tab reaches the switch and Add peer, Enter opens, Escape returns
// focus); the peer as a node in Graph and as a step in the pipeline designer, drawn and listed distinctly; no exception or
// CSP message. Jobs never run here. PB_NETWORK_SCREENSHOTS=<folder> saves PNGs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockPeer } from './helpers/a2a-peer.mjs';
import { findChrome, launch } from './helpers/browser.mjs';
import { startTestServer } from './helpers/test-server.mjs';

const chrome = await findChrome();
const J = JSON.stringify;
const N = name => `n_${createHash('sha256').update(`step:${name}`).digest('hex').slice(0, 12)}`;

test('Federation in Chrome: both themes at 1440 and 390 px, peer preview → review → approve, inbound publishing and a caller token, the keyboard, and remote peers in Graph and Pipelines', { skip: !chrome, timeout: 300000 }, async t => {
  const peer = await mockPeer(t, { card: () => ({ name: 'Research <img src=x onerror="window.__pwned=1"> peer', description: '<script>window.__pwned=2</script>Answers research questions.' }) });
  const app = await startTestServer(t, { port: 0, executor: null, networkWorker: null });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const call = async (path, method = 'GET', body) => (await fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) })).json();
  await app.board.base.create({ id: 'lead', kind: 'profile', name: 'Research lead', configuration: { agent: { provider: 'claude' } } });
  const lead = (await call('/api/network/agents', 'POST', { baseResourceId: 'lead', expectedRevision: (await call('/api/network/agents')).revision })).agent;
  await call('/api/network/listener', 'PATCH', { enabled: true, port: 0 });

  const browser = await launch({ width: 1440, height: 1000 }); assert.ok(browser); t.after(() => browser.close());
  const ev = code => browser.eval(code), wait = (expression, label, ms = 20000) => browser.until(expression, label, ms);
  const shots = process.env.PB_NETWORK_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shot = async name => { if (shots) await writeFile(join(shots, `${name}.png`), await browser.screenshot()); };
  const noSideways = 'document.documentElement.scrollWidth <= document.documentElement.clientWidth';
  const press = async (key, code, keyCode, text) => { await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); };
  await browser.goto(`${app.url}/#/network/federation`);
  await wait(`document.querySelector('#network-federation-outbound-status')?.textContent.startsWith('Off')`, 'Federation loaded, off');
  assert.deepEqual(await ev(`return [document.querySelector('#network-federation-outbound').checked, document.querySelector('#network-federation-inbound').checked, document.querySelector('#network-federation-add-peer').disabled,
    document.querySelector('#network-tab-federation').getAttribute('aria-selected'), document.querySelector('#network-tab-federation .network-soon') === null];`), [false, false, true, 'true', true], 'off by default, and no longer marked "soon"');

  // Keyboard: Tab from the section tab reaches the outbound switch; Space turns it on; Tab reaches Add peer; Enter opens
  // the dialog with the URL focused; Escape closes it and focus returns to Add peer.
  await ev(`document.querySelector('#network-tab-federation').focus();`);
  await browser.key('Tab', 'Tab', 9);
  await wait(`document.activeElement?.id === 'network-federation-outbound'`, 'Tab reaches the outbound switch');
  await press(' ', 'Space', 32, ' ');
  await wait(`document.querySelector('#network-federation-outbound-status').textContent.startsWith('On') && !document.querySelector('#network-federation-add-peer').disabled`, 'Space turns outbound on');
  await ev(`document.querySelector('#network-federation-add-peer').focus();`);
  assert.notEqual(await ev(`return getComputedStyle(document.activeElement).outlineStyle;`), 'none', 'visible focus on Add peer');
  await press('Enter', 'Enter', 13, '\r');
  await wait(`document.querySelector('#network-federation-dialog')?.open && document.activeElement?.id === 'network-peer-url'`, 'Enter opens the add dialog');
  await browser.key('Escape', 'Escape', 27);
  await wait(`!document.querySelector('#network-federation-dialog').open && document.activeElement?.id === 'network-federation-add-peer'`, 'Escape returns focus');

  // Preview → review (the card's own text, as text) → approve.
  await ev(`document.querySelector('#network-federation-add-peer').click();`);
  await wait(`document.activeElement?.id === 'network-peer-url'`, 'add dialog');
  await ev(`document.querySelector('#network-peer-url').value = ${J(peer.cardUrl)}; document.querySelector('#network-peer-local').checked = true; document.querySelector('#network-peer-preview').click();`);
  await wait(`document.querySelector('#network-peer-review') && document.activeElement?.id === 'network-peer-approve'`, 'the review').catch(async error => { throw new Error(`${error.message}: ${await ev(`return [document.activeElement?.id, document.querySelector('#network-federation-dialog')?.innerText.slice(0, 600)];`)}`); });
  assert.deepEqual(await ev(`const review = document.querySelector('#network-peer-review'); return [review.textContent.includes('<img src=x'), review.querySelectorAll('img, script').length, window.__pwned ?? null,
    document.querySelectorAll('#network-peer-warnings li').length > 0, review.textContent.includes('Answers a question.')];`), [true, 0, null, true, true], 'untrusted card text stays text');
  await shot('federation-review-1440');
  await ev(`document.querySelector('#network-peer-approve').click();`);
  await wait(`document.querySelectorAll('#network-federation-peers > li').length === 1 && !document.querySelector('#network-federation-dialog').open`, 'the peer is trusted');
  assert.equal(await ev(`return document.querySelector('#network-federation-peers').textContent.includes('Local test peer') && document.querySelectorAll('#network-federation-peers img').length === 0;`), true);

  // Inbound: publish the agent, turn inbound on; the card address appears.
  await wait(`document.querySelector('#network-publish-${lead.id}')`, 'the publish list');
  await ev(`document.querySelector('#network-publish-${lead.id}').checked = true; document.querySelector('#network-publish-description-${lead.id}').value = 'Answers research questions.'; document.querySelector('#network-federation-publish-save').click();`);
  await wait(`document.querySelector('#network-status').textContent.includes('published for A2A')`, 'published');
  await ev(`document.querySelector('#network-federation-inbound').click();`);
  await wait(`document.querySelector('#network-federation-inbound-status').dataset.state === 'on' && /agent-card\\.json/.test(document.querySelector('#network-federation-card-url').textContent)`, 'inbound on with a card address');
  // An A2A caller: its token shows once and leaves the page when the dialog closes.
  await ev(`document.querySelector('#network-federation-create-caller').click();`);
  await wait(`document.activeElement?.id === 'network-caller-name'`, 'caller dialog');
  await ev(`document.querySelector('#network-caller-name').value = 'Partner agent'; document.querySelector('#network-caller-submit').click();`);
  await wait(`/^pbm_cli_/.test(document.querySelector('#network-caller-token')?.textContent || '')`, 'caller token').catch(async error => { throw new Error(`${error.message}: ${await ev(`return [document.activeElement?.id, document.querySelector('#network-federation-dialog')?.innerText.slice(0, 900)];`)}`); });
  await shot('federation-token-1440');
  await ev(`document.querySelector('#network-caller-token-done').click();`);
  await wait(`!document.querySelector('#network-federation-dialog').open && !document.body.innerHTML.includes('pbm_cli_') && document.querySelectorAll('#network-federation-callers > li[data-client-id]').length === 1`, 'token gone, caller listed');

  for (const theme of ['light', 'dark']) {
    await ev(`localStorage.setItem('ste-prompt-engineer.theme', ${J(theme)});`);
    await browser.reload();
    await browser.resize(1440, 1000);
    await wait(`(document.documentElement.dataset.theme || 'light') === ${J(theme)} && document.querySelectorAll('#network-federation-peers > li').length === 1 && document.querySelector('#network-federation-inbound-status').dataset.state === 'on'`, `${theme}: loaded`);
    assert.equal(await browser.layout(`const peers = document.querySelector('#network-federation-peers').getBoundingClientRect(), side = document.querySelector('.network-federation .network-clients-side').getBoundingClientRect();
      return ${noSideways} && side.left >= peers.right && peers.width > 400;`), true, `${theme}: inbound and callers beside the peers at 1440`);
    const colors = await ev(`return getComputedStyle(document.querySelector('.network-federation .network-clients-card')).backgroundColor;`);
    assert.equal(theme === 'dark' ? colors !== 'rgb(255, 255, 255)' : colors === 'rgb(255, 255, 255)', true, `${theme}: the cards follow the theme (${colors})`);
    await shot(`federation-1440-${theme}`);
    await browser.resize(390, 844);
    assert.equal(await browser.layout(`const peers = document.querySelector('#network-federation-peers').getBoundingClientRect(), side = document.querySelector('.network-federation .network-clients-side').getBoundingClientRect();
      return ${noSideways} && side.top >= peers.bottom && peers.right <= innerWidth;`), true, `${theme}: one column at 390, nothing sideways`);
    await shot(`federation-390-${theme}`);
    await ev(`document.querySelector('[id^="network-peer-refresh-"]').click();`);
    await wait(`document.querySelector('#network-peer-review')`, `${theme}: refresh review at 390`);
    assert.equal(await browser.layout(`const box = document.querySelector('#network-federation-dialog').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 && ${noSideways};`), true, `${theme}: the review fits at 390`);
    await shot(`federation-review-390-${theme}`);
    await ev(`document.querySelector('#network-federation-dialog .dialog-close').click();`);
    await browser.resize(1440, 1000);
  }

  // The peer in Graph (its own node type and mark, relations to it marked remote) and in the pipeline designer.
  const peerId = (await call('/api/network/federation')).peers[0].id;
  const network = (await call('/api/network/networks', 'POST', { name: 'Mixed team', nodes: [{ id: N('remote'), type: 'federated', peerId, position: { x: 260, y: 0 } }, { id: N('lead'), type: 'agent', agentId: lead.id, position: { x: 0, y: 0 } }],
    edges: [{ id: 'e_000000000001', from: N('lead'), to: N('remote'), relation: 'delegate' }] })).network;
  await call(`/api/network/networks/${network.id}/publish`, 'POST', { expectedRevision: network.revision });
  const pipeline = (await call('/api/network/pipelines', 'POST', { networkId: network.id, networkVersion: 1, name: 'Remote research',
    nodes: [{ id: N('step'), type: 'federated', label: '', position: { x: 0, y: 0 }, config: { peerId } }, { id: N('out'), type: 'output', label: '', position: { x: 240, y: 0 }, config: { include: [N('step')] } }],
    edges: [{ id: 'e_000000000002', from: N('step'), to: N('out'), fromPort: 'text' }] })).pipeline;
  await ev(`location.hash = '#/network/graph/${network.id}';`); // The same document: a hash change, not a page load.
  await wait(`document.querySelector('[data-node-id="${N('remote')}"]')`, 'graph lists');
  assert.deepEqual(await ev(`const row = document.querySelector('[data-node-id="${N('remote')}"]'); return [row.querySelector('.network-node-mark').textContent, row.textContent.includes('Remote A2A peer'), row.textContent.includes('<img'), document.querySelectorAll('#network-graph-nodes img').length,
    document.querySelector('#network-graph-edges').textContent.includes('remote peer')];`), ['⇄', true, true, 0, true]);
  if (await ev(`return Boolean(window.cytoscape);`)) {
    await wait(`document.querySelector('#network-canvas canvas')`, 'graph canvas');
    await shot('graph-remote-1440');
  }
  await ev(`document.querySelector('[data-node-id="${N('remote')}"]').click();`);
  await wait(`document.querySelector('#network-graph-open-federation')`, 'remote node details');
  await ev(`location.hash = '#/network/pipelines/${pipeline.id}';`);
  await wait(`document.querySelector('#network-pipeline-add-federated') && document.querySelector('[data-step-id="${N('step')}"], [data-node-id="${N('step')}"]')`, 'pipeline designer');
  await ev(`(document.querySelector('[data-step-id="${N('step')}"]') || document.querySelector('[data-node-id="${N('step')}"]')).click();`);
  await wait(`document.querySelector('#network-pipeline-peer')?.value === ${J(peerId)}`, 'the remote step form');
  assert.equal(await ev(`return document.querySelector('#network-pipeline-add-federated').textContent.includes('Remote peer');`), true);
  await shot('pipeline-remote-1440');
  await browser.resize(390, 844);
  assert.equal(await browser.layout(`return ${noSideways};`), true, 'pipeline designer at 390');

  const problems = browser.consoleMessages.filter(text => /EXCEPTION|Content Security Policy|Refused to/i.test(text));
  assert.deepEqual(problems, []);
  assert.equal(await ev(`return window.__pwned ?? null;`), null, 'no card text ever ran');
});
