// The outbound A2A guard and card normalisation (src/network/a2a-client.mjs, src/network/a2a-registry.mjs,
// src/base-context.mjs isPublicAddress): https only (plain http only to this computer for a local test peer); every DNS
// answer checked and the connection pinned to the checked address, on every hop (redirects and rebinding); private,
// loopback and reserved addresses refused unless one is explicitly allowed; origin allowlists; same-origin redirects only,
// so a credential never reaches another host; size and time limits; the remote-state mapping; untrusted card text bounded.
// An injected resolver and transport stand in for the internet; real sockets are on 127.0.0.1 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { TaskState } from '@a2a-js/sdk';
import { isPublicAddress } from '../src/base-context.mjs';
import { A2A_LIMITS, allowedAddress, checkUrl, guardedFetch, nodeTransport, remoteOutcome } from '../src/network/a2a-client.mjs';
import { normalizeCard } from '../src/network/a2a-registry.mjs';

const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
const PUBLIC = '93.184.216.34';
/** A transport that answers from a script and records every call: no socket is opened. */
function scripted(...answers) {
  const calls = [];
  const transport = async request => {
    calls.push({ url: request.url.href, address: request.address.address, method: request.method, headers: request.headers });
    const [status, headers = {}, body = '{}'] = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { status, headers, body: Readable.from([Buffer.from(body)]) };
  };
  return { calls, transport };
}
const resolver = (...answers) => { const asked = []; const lookup = async host => { asked.push(host); const next = answers[Math.min(asked.length - 1, answers.length - 1)]; return next.map(address => ({ address, family: address.includes(':') ? 6 : 4 })); }; lookup.asked = asked; return lookup; };

test('URLs: https only; plain http only to this computer for a local test peer; no user info, fragment or other scheme', () => {
  assert.equal(checkUrl('https://peer.example/.well-known/agent-card.json').origin, 'https://peer.example');
  for (const [url, options, expected] of [['http://peer.example/card', {}, 'A2A_URL_INSECURE'], ['https://user:pw@peer.example/', {}, 'A2A_URL_INVALID'], ['https://peer.example/#x', {}, 'A2A_URL_INVALID'],
    ['javascript:alert(1)', {}, 'A2A_URL_INSECURE'], ['file:///etc/passwd', {}, 'A2A_URL_INSECURE'], ['not a url', {}, 'A2A_URL_INVALID'], [`https://peer.example/${'a'.repeat(2100)}`, {}, 'A2A_URL_INVALID'],
    ['http://peer.example/', { localTest: true }, 'A2A_URL_INSECURE'], ['http://10.0.0.1/', { localTest: true }, 'A2A_URL_INSECURE']]) {
    assert.throws(() => checkUrl(url, options), code(expected), url);
  }
  for (const url of ['http://127.0.0.1:5/x', 'http://localhost:5/x', 'http://[::1]:5/x', 'https://127.0.0.2/x']) assert.ok(checkUrl(url, { localTest: true }), url);
});

test('addresses: private, loopback, link-local, reserved and disguised IPv6 forms are refused; one explicit private address may be allowed; a local test peer reaches only this computer', () => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(allowedAddress(address), false, address);
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [PUBLIC, '2606:4700:4700::1111', '::ffff:93.184.216.34']) assert.equal(allowedAddress(address), true, address);
  assert.equal(allowedAddress('10.0.0.5', { privateAddress: '10.0.0.5' }), true);
  assert.equal(allowedAddress('10.0.0.6', { privateAddress: '10.0.0.5' }), false);
  assert.equal(allowedAddress('fd00::5', { privateAddress: 'fd00:0:0:0:0:0:0:5' }), true, 'the same address in another spelling');
  for (const [address, ok] of [['127.0.0.1', true], ['::1', true], ['::ffff:127.0.0.1', true], [PUBLIC, false], ['10.0.0.1', false]]) assert.equal(allowedAddress(address, { localTest: true }), ok, address);
});

test('DNS: every answer is checked before any connection, the connection is pinned to the checked address, and a later hop is checked again (rebinding refused)', async () => {
  const origins = new Set(['https://peer.example']);
  // A private answer, or a mix of public and private answers: refused before the transport is ever called.
  for (const answer of [['10.0.0.1'], [PUBLIC, '127.0.0.1'], ['::ffff:169.254.169.254'], []]) {
    const { calls, transport } = scripted([200]);
    await assert.rejects(guardedFetch({ origins, lookup: resolver(answer), transport })('https://peer.example/a2a'), code('A2A_ADDRESS_REFUSED'), answer.join());
    assert.equal(calls.length, 0);
  }
  // Pinned: the transport is handed the address that was checked; the name is resolved once per hop.
  const lookup = resolver([PUBLIC], ['127.0.0.1']), { calls, transport } = scripted([200, {}, '{"ok":true}']);
  assert.deepEqual(await (await guardedFetch({ origins, lookup, transport })('https://peer.example/a2a')).json(), { ok: true });
  assert.deepEqual([calls.length, calls[0].address, lookup.asked], [1, PUBLIC, ['peer.example']]);
  // Rebinding across a redirect: the first hop resolves publicly, the same-origin second hop to loopback → refused.
  const rebinding = resolver([PUBLIC], ['127.0.0.1']), hops = scripted([307, { location: '/moved' }], [200]);
  await assert.rejects(guardedFetch({ origins, lookup: rebinding, transport: hops.transport })('https://peer.example/a2a', { method: 'POST', body: '{}' }), code('A2A_ADDRESS_REFUSED'));
  assert.deepEqual([hops.calls.length, rebinding.asked.length], [1, 2]);
  // A real socket connects to the pinned address even though the name itself does not resolve.
  const server = http.createServer((req, res) => res.end('pinned'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await nodeTransport({ url: new URL(`http://peer.invalid:${server.address().port}/x`), address: { address: '127.0.0.1', family: 4 }, method: 'GET', headers: {}, body: null, signal: null, connectMs: 2000, idleMs: 2000 });
    let text = ''; for await (const chunk of answer.body) text += chunk;
    assert.deepEqual([answer.status, text], [200, 'pinned']);
  } finally { server.close(); }
});

test('redirects: only within the same origin; to another origin (also http on the same host) nothing is sent there; a credential goes only to its own origin; caller headers cannot add one', async () => {
  const origins = new Set(['https://peer.example', 'https://cards.example']), lookup = resolver([PUBLIC]);
  const credential = { origin: 'https://peer.example', header: 'authorization', value: 'Bearer SECRET' };
  for (const location of ['https://evil.example/steal', 'http://peer.example/a2a', 'https://peer.example:8443/a2a', 'https://cards.example/a2a']) {
    const { calls, transport } = scripted([302, { location }], [200]);
    await assert.rejects(guardedFetch({ origins, lookup, transport, credential })('https://peer.example/card'), code('A2A_REDIRECT_REFUSED'), location);
    assert.equal(calls.length, 1, `${location}: the other origin was never contacted`);
  }
  // Same origin: followed (GET), the credential kept because the origin is the same.
  const same = scripted([301, { location: '/v2/card' }], [200, {}, '{}']);
  await guardedFetch({ origins, lookup, transport: same.transport, credential })('https://peer.example/card');
  assert.deepEqual(same.calls.map(call => [call.url, call.headers.authorization]), [['https://peer.example/card', 'Bearer SECRET'], ['https://peer.example/v2/card', 'Bearer SECRET']]);
  // A POST is redirected only with 307/308 (which keep it); a 302 would turn it into something else.
  const changed = scripted([302, { location: '/x' }], [200]); // The second hop would answer: only the 302 rule refuses it.
  await assert.rejects(guardedFetch({ origins, lookup, transport: changed.transport })('https://peer.example/a2a', { method: 'POST', body: '{}' }), code('A2A_REDIRECT_REFUSED'));
  assert.equal(changed.calls.length, 1);
  const kept = scripted([307, { location: '/v2/a2a' }], [200, {}, '{}']);
  await guardedFetch({ origins, lookup, transport: kept.transport })('https://peer.example/a2a', { method: 'POST', body: '{}' });
  assert.deepEqual(kept.calls.map(call => [call.url, call.method]), [['https://peer.example/a2a', 'POST'], ['https://peer.example/v2/a2a', 'POST']], 'a 307 keeps the POST');
  await assert.rejects(guardedFetch({ origins, lookup, transport: scripted([307, { location: '/again' }]).transport, limits: { ...A2A_LIMITS, redirects: 2 } })('https://peer.example/a2a'), code('A2A_REDIRECT_REFUSED'), 'too many redirects');
  // The credential is never sent to another allowed origin, and a caller's own Authorization or Cookie header is dropped.
  const card = scripted([200]);
  await guardedFetch({ origins, lookup, transport: card.transport, credential })('https://cards.example/card', { headers: { Authorization: 'Bearer FROM-CALLER', Cookie: 'a=b', 'A2A-Version': '1.0' } });
  assert.deepEqual([card.calls[0].headers.authorization, card.calls[0].headers.cookie, card.calls[0].headers['a2a-version']], [undefined, undefined, '1.0']);
  // An origin that is not on the allowlist is refused before any lookup.
  const unasked = resolver([PUBLIC]);
  await assert.rejects(guardedFetch({ origins, lookup: unasked, transport: card.transport })('https://other.example/'), code('A2A_ORIGIN_REFUSED'));
  assert.equal(unasked.asked.length, 0);
});

test('answers and bodies: non-2xx answers become fixed codes; oversized and slow bodies are cut off; oversized requests are refused', async () => {
  const origins = new Set(['https://peer.example']), lookup = resolver([PUBLIC]);
  for (const [status, expected] of [[401, 'REMOTE_AUTH'], [403, 'REMOTE_AUTH'], [404, 'REMOTE_NOT_FOUND'], [429, 'REMOTE_BUSY'], [400, 'REMOTE_REFUSED'], [500, 'REMOTE_SERVER_ERROR']]) {
    await assert.rejects(guardedFetch({ origins, lookup, transport: scripted([status, {}, 'SECRET REMOTE BODY']).transport })('https://peer.example/a2a'), error => error.code === expected && !error.message.includes('SECRET'), String(status));
  }
  await assert.rejects(guardedFetch({ origins, lookup, transport: scripted([200, { 'content-length': '5000' }, 'x']).transport, maxBytes: 1024 })('https://peer.example/a2a'), code('PEER_RESPONSE_TOO_LARGE'));
  const big = await guardedFetch({ origins, lookup, transport: scripted([200, {}, 'x'.repeat(5000)]).transport, maxBytes: 1024 })('https://peer.example/a2a');
  await assert.rejects(big.text(), code('PEER_RESPONSE_TOO_LARGE'));
  await assert.rejects(guardedFetch({ origins, lookup, transport: scripted([200]).transport, limits: { ...A2A_LIMITS, requestBytes: 10 } })('https://peer.example/a2a', { method: 'POST', body: 'x'.repeat(11) }), code('A2A_REQUEST_TOO_LARGE'));
  // Real sockets on 127.0.0.1 (a local test peer): a body that stalls, an answer that never comes, a body that never ends.
  const server = http.createServer((req, res) => {
    if (req.url === '/stall') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"a":'); return; }
    if (req.url === '/silent') return;
    if (req.url === '/flood') { res.writeHead(200); const pump = () => { while (res.write('x'.repeat(65536))) {} }; pump(); res.on('drain', pump); return; }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, local = guardedFetch({ origins: new Set([base]), localTest: true, limits: { ...A2A_LIMITS, idleMs: 300, requestMs: 2000 }, maxBytes: 256 * 1024 });
  try {
    await assert.rejects((await local(`${base}/stall`)).text(), code('PEER_TIMEOUT'), 'a stalled body ends after the idle limit');
    await assert.rejects(local(`${base}/silent`), code('PEER_TIMEOUT'), 'no answer ends after the idle limit');
    await assert.rejects((await local(`${base}/flood`)).text(), code('PEER_RESPONSE_TOO_LARGE'));
    assert.equal(await (await local(`${base}/ok`)).text(), '{}');
    await assert.rejects(guardedFetch({ origins: new Set([base]), localTest: true, lookup: resolver([PUBLIC]) })(`${base}/ok`), code('A2A_ADDRESS_REFUSED'), 'a local test peer that resolves elsewhere is refused');
  } finally { server.closeAllConnections(); server.close(); }
});

test('remote task states map to the job lifecycle; anything the protocol does not define is unknown, never success', () => {
  const map = Object.fromEntries(Object.entries(TaskState).filter(([key]) => /^TASK_STATE_/.test(key)).map(([key, value]) => [key, remoteOutcome(value)]));
  assert.deepEqual(Object.fromEntries(Object.entries(map).map(([key, value]) => [key, [value.status, value.errorCode ?? null]])), {
    TASK_STATE_UNSPECIFIED: ['unknown', 'REMOTE_STATE_UNKNOWN'], TASK_STATE_SUBMITTED: ['running', null], TASK_STATE_WORKING: ['running', null], TASK_STATE_COMPLETED: ['completed', null],
    TASK_STATE_FAILED: ['failed', 'REMOTE_FAILED'], TASK_STATE_CANCELED: ['failed', 'REMOTE_CANCELLED'], TASK_STATE_INPUT_REQUIRED: ['failed', 'REMOTE_INPUT_REQUIRED'],
    TASK_STATE_REJECTED: ['failed', 'REMOTE_REJECTED'], TASK_STATE_AUTH_REQUIRED: ['failed', 'REMOTE_AUTH_REQUIRED'] });
  for (const odd of [-1, 99, null, undefined, 'TASK_STATE_COMPLETED']) assert.equal(remoteOutcome(odd).status, 'unknown', String(odd));
});

test('card normalisation: proto-JSON and JSON-Schema security schemes; bounded text; no keyed object a card can poison; the endpoint must follow the URL policy; at most 64 KiB kept', () => {
  const endpoint = { supportedInterfaces: [{ url: 'https://api.peer.example/a2a', protocolBinding: 'jsonrpc', protocolVersion: '1.0' }] };
  const { card, warnings } = normalizeCard({ name: '  Peer\nName ', ...endpoint, securitySchemes: { a: { httpAuthSecurityScheme: { scheme: 'Bearer' } }, b: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, c: { type: 'http', scheme: 'basic' }, 'bad key!': { type: 'http' } },
    security: [{ b: [] }], securityRequirements: [{ schemes: { a: { list: [] } } }], defaultInputModes: ['text/plain', '<script>', 7], capabilities: { streaming: 'yes' } }, { cardUrl: 'https://peer.example/.well-known/agent-card.json' });
  assert.equal(card.name, 'Peer Name');
  assert.deepEqual(card.securitySchemes.map(item => [item.name, item.type, item.header ?? null]), [['a', 'bearer', null], ['b', 'apiKey', 'X-Api-Key'], ['c', 'http', null]]);
  assert.deepEqual([card.security, card.defaultInputModes, card.capabilities.streaming], [['a', 'b'], ['text/plain'], false]);
  assert.ok(warnings.some(text => /another origin/.test(text)), 'an endpoint on another origin is pointed out');
  const huge = normalizeCard({ name: 'Big', ...endpoint, skills: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: 'n'.repeat(120), description: 'd'.repeat(1000), tags: Array(20).fill('t'.repeat(40)), examples: Array(5).fill('e'.repeat(300)) })) }, { cardUrl: 'https://api.peer.example/card' });
  assert.ok(Buffer.byteLength(JSON.stringify(huge.card)) <= 64 * 1024 && huge.card.skills.length < 50);
  for (const [raw, expected] of [[null, 'CARD_INVALID'], [{ ...endpoint }, 'CARD_INVALID'], [{ name: 'x', supportedInterfaces: [{ url: 'http://api.peer.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }, 'CARD_ENDPOINT_REFUSED'],
    [{ name: 'x', supportedInterfaces: [{ url: 'https://api.peer.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '../x' }] }, 'CARD_INVALID'], [{ name: 'x', supportedInterfaces: 'nope' }, 'CARD_UNSUPPORTED']]) {
    assert.throws(() => normalizeCard(raw, { cardUrl: 'https://peer.example/card' }), code(expected), JSON.stringify(raw));
  }
});
