// Security audit review 4, the page side in jsdom against the real server (P4-5): Refresh card… shows the credential choice;
// when the card moves the endpoint to another origin it says so and the credential is not carried over unless named again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockPeer } from './helpers/a2a-peer.mjs';
import { setup, until } from './helpers/ui-harness.mjs';

const TOKEN_ENV = 'PROMPTBOARD_A2A_PEER_TOKEN';
async function call(ctx, path, method = 'GET', body) {
  const response = await fetch(`${ctx.app.url}${path}`, { method, headers: { 'X-STE-Token': ctx.win.__pbTest.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

test('P4-5: Refresh card… offers the credential; an endpoint moved to another origin is named and the credential is not carried there', async t => {
  let moved = null;
  const other = await mockPeer(t), peer = await mockPeer(t, { token: 'x', card: () => (moved ? { supportedInterfaces: [{ url: `${moved}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] } : {}) });
  const ctx = await setup(t, { executor: null }), { $, win } = ctx;
  await call(ctx, '/api/network/federation/outbound', 'PATCH', { expectedRevision: 0, enabled: true });
  const { preview } = await call(ctx, '/api/network/federation/peers/preview', 'POST', { url: peer.cardUrl, localTest: true });
  const { peer: trusted } = await call(ctx, '/api/network/federation/peers', 'POST', { url: peer.cardUrl, localTest: true, cardSha256: preview.cardSha256, expectedRevision: 1, credentialEnv: TOKEN_ENV, credentialScheme: 'bearer' });
  win.location.hash = '#/network/federation';
  const refresh = () => $(`#network-peer-refresh-${trusted.id}`);
  await until(() => refresh(), 'the peer is listed');
  // The same origin: the credential is shown as it is and kept.
  refresh().click();
  await until(() => $('#network-peer-review'), 'the refresh review');
  assert.equal($('#network-peer-env')?.value, TOKEN_ENV, 'the refresh dialog shows the credential');
  assert.ok(!/moved/.test($('#network-peer-review').textContent));
  $('#network-federation-dialog .dialog-close').click();
  // Another origin: said plainly, the credential field starts empty, and keeping the card drops the credential.
  moved = other.url;
  refresh().click();
  await until(() => $('#network-peer-review'), 'the refresh review after the move');
  const text = $('#network-peer-review').textContent;
  assert.ok(text.includes(new URL(peer.url).origin) && text.includes(new URL(other.url).origin) && /moved/.test(text), text);
  assert.equal($('#network-peer-env').value, '');
  $('#network-peer-approve').click();
  await until(async () => (await call(ctx, '/api/network/federation')).peers[0].card.endpoint.url === `${other.url}/a2a`, 'the new card is kept');
  assert.equal((await call(ctx, '/api/network/federation')).peers[0].credential, null);
});
