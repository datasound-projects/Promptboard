import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const domSource = await readFile(new URL('../public/dom.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/chat.js', import.meta.url), 'utf8');
const until = async (fn, label) => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const build = { version: '0.4.0', fingerprint: 'current-build', id: '0.4.0+current-build' };
const doc = { id: 's_fixture', title: 'Network guide', kind: 'guide', path: 'docs/network/user-guide.md', page: '#/network', text: 'The owner approves an approval step before later steps run.' };
const assistant = (number, text = 'Open Network and use an approval step.') => ({ id: `assistant-${number}`, role: 'assistant', status: 'completed', text, build, capturedAt: Date.now(), sections: [{ text, citations: [{ sourceId: doc.id, quote: doc.text }] }], sources: [doc], uncertainties: [] });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, options = {}) {
  const dom = new JSDOM('<main id="chat-view"></main><aside id="chat-sidebar-panel"></aside>', { url: 'http://127.0.0.1/#/chat', runScripts: 'outside-only' });
  const win = dom.window; win.TextDecoder = TextDecoder; win.AbortController = AbortController;
  const errors = []; win.addEventListener('error', event => errors.push(event.error));
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  const copied = []; Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async text => copied.push(text) } });
  t.after(() => win.close()); win.eval(domSource); win.eval(source);
  const chats = new Map(), requests = [], streams = []; let count = 0;
  const metadata = { build: { ...build }, providers: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'gemini', name: 'Gemini CLI' }], modes: ['workspace', 'guide'], missingGuides: [] };
  const create = (mode = 'workspace') => { const chat = { id: id(++count), mode, title: 'New conversation', settings: { provider: 'claude', model: '', effort: '' }, messages: [], running: false }; chats.set(chat.id, chat); return chat; };
  const api = async (path, { method = 'GET', body } = {}) => {
    requests.push({ path, method, body }); let data;
    if (path === '/api/chat') data = metadata;
    else if (path === '/api/chat/conversations' && method === 'GET') data = { chats: [...chats.values()].map(chat => ({ ...chat, messages: chat.messages.length })) };
    else if (path === '/api/chat/conversations' && method === 'POST') {
      const chat = create(body.mode); chat.settings = body.settings;
      if (options.createGate) await options.createGate.promise;
      data = { chat };
    } else {
      const match = /\/conversations\/([^/]+)(?:\/(stop))?$/.exec(path), chat = chats.get(match?.[1]);
      if (!chat) return { response: { ok: false, status: 404 }, data: { error: 'Missing conversation' } };
      if (match[2]) { data = { stopped: true }; options.stopped?.(chat.id); }
      else if (method === 'DELETE') { chats.delete(chat.id); data = { removed: true }; }
      else data = { chat };
    }
    return { response: { ok: true, status: 200 }, data: structuredClone(data) };
  };
  const streamApi = async (path, body) => {
    requests.push({ path, method: 'POST', body });
    if (options.rejectSend) return new Response(JSON.stringify({ error: 'The CLI slot is busy.' }), { status: 409 });
    const chat = chats.get(path.split('/')[4]); chat.running = true;
    let writer;
    const response = new Response(new ReadableStream({ start(controller) { writer = controller; } }), { status: 200 });
    const emit = event => {
      if (event.type === 'accepted') { chat.messages.push(event.message); chat.title = event.message.text.slice(0, 80); }
      if (event.type === 'answer') chat.messages.push(event.message);
      if (event.type === 'done') { chat.running = false; Object.assign(chat, event.chat); }
      writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
    };
    const stream = { id: chat.id, body, emit, close: () => writer.close(), complete: (text = 'Open Network and use an approval step.') => { emit({ type: 'accepted', message: { id: `user-${chat.id}`, role: 'user', text: body.text } }); emit({ type: 'answer', message: assistant(chat.id, text) }); emit({ type: 'done', chat: { id: chat.id, mode: chat.mode, title: chat.title, running: false } }); writer.close(); } };
    streams.push(stream); if (!options.hold) stream.complete(); return response;
  };
  const view = win.PromptboardChat.create({ api, streamApi, providers: () => [{ id: 'claude', available: true }, { id: 'codex', available: true }], defaults: () => ({ provider: 'claude', model: '', effort: '' }), announce: () => {}, browserContext: () => ({ history: [{ id: 'private', title: 'PRIVATE_BROWSER_HISTORY' }], catalog: [], total: 1 }), refreshProviders: async () => {} });
  win.addEventListener('hashchange', () => { if (/^#\/chat(?:\/|$)/.test(win.location.hash)) void view.show(); else view.leave(); });
  const $ = selector => win.document.querySelector(selector);
  const enter = value => { $('#chat-input').value = value; $('#chat-input').dispatchEvent(new win.Event('input', { bubbles: true })); };
  const send = value => { enter(value); $('#chat-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); };
  await view.show(); return { win, view, $, enter, send, chats, create, requests, streams, metadata, errors, copied };
}

test('a conversation saves on first send, cites sources, copies provenance and survives reopening', async t => {
  const ui = await fixture(t); ui.send('How do I use approval steps?');
  await until(() => ui.$('.chat-message-assistant'), 'assistant answer');
  await until(() => ui.$('#chat-stop').hidden, 'response finished');
  assert.match(ui.win.location.hash, /^#\/chat\//);
  assert.equal(ui.$('#chat-input').value, '');
  const citation = ui.$('.chat-source-buttons button'); citation.click();
  assert.equal(citation.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.$('.chat-source-panel blockquote').textContent, doc.text);
  ui.$('.chat-message-actions button').click();
  await until(() => ui.copied.length, 'copied'); assert.match(ui.copied[0], /Network guide/);
  await ui.view.show(); assert.equal(ui.win.document.querySelectorAll('.chat-message-assistant').length, 1);
  const historyLink = ui.$('#chat-history-list a'); historyLink.focus();
  await ui.view.show();
  assert.equal(historyLink.isConnected, true, 'an unchanged history row stays under an in-flight pointer');
  assert.equal(ui.win.document.activeElement, historyLink, 'history refresh preserves keyboard focus');
  assert.deepEqual(ui.errors, []);
});

test('drafts are cleared only on acceptance and a follow-up typed during generation retains text and caret', async t => {
  const ui = await fixture(t, { hold: true }); ui.send('Original question');
  await until(() => ui.streams.length, 'stream opened'); const stream = ui.streams[0];
  assert.equal(ui.$('#chat-input').value, 'Original question', 'not cleared before server acceptance');
  stream.emit({ type: 'accepted', message: { id: 'user-1', role: 'user', text: 'Original question' } });
  await until(() => ui.$('#chat-input').value === '', 'accepted');
  ui.enter('My next question'); ui.$('#chat-input').focus(); ui.$('#chat-input').setSelectionRange(3, 7);
  stream.emit({ type: 'answer', message: assistant(1) }); stream.emit({ type: 'done', chat: { id: stream.id, running: false } }); stream.close();
  await until(() => ui.$('#chat-stop').hidden, 'finished');
  assert.equal(ui.$('#chat-input').value, 'My next question'); assert.equal(ui.win.document.activeElement.id, 'chat-input');
  assert.deepEqual([ui.$('#chat-input').selectionStart, ui.$('#chat-input').selectionEnd], [3, 7]);
});

test('an early request error keeps the question editable and creates no false answer', async t => {
  const ui = await fixture(t, { rejectSend: true }); ui.send('Keep this unsent question');
  await until(() => ui.$('#chat-error').textContent.includes('busy'), 'busy error');
  assert.equal(ui.$('#chat-input').value, 'Keep this unsent question');
  assert.equal(ui.$('.chat-message-assistant'), null);
});

test('the global Chat action returns to the current conversation and preserves its unsent draft', async t => {
  const ui = await fixture(t); ui.send('Explain Network');
  await until(() => ui.$('.chat-message-assistant') && ui.$('#chat-stop').hidden, 'saved conversation');
  const hash = ui.win.location.hash;
  ui.enter('My unfinished follow-up'); ui.win.location.hash = '#/base'; ui.view.leave();
  ui.view.open();
  await until(() => ui.win.location.hash === hash && ui.$('#chat-input').value === 'My unfinished follow-up', 'return to current draft');
  assert.equal(ui.win.document.querySelectorAll('.chat-message-assistant').length, 1);
});

test('browser History is opt-in for Workspace and never included in App guide requests', async t => {
  const ui = await fixture(t); ui.send('Workspace question');
  await until(() => ui.streams.length === 1 && ui.$('#chat-stop').hidden, 'first response');
  assert.equal(ui.streams[0].body.browserContext, undefined);
  ui.$('#chat-include-history').checked = true; ui.send('Look in my browser History');
  await until(() => ui.streams.length === 2 && ui.$('#chat-stop').hidden, 'second response');
  assert.equal(ui.streams[1].body.browserContext.history[0].title, 'PRIVATE_BROWSER_HISTORY');
  ui.$('[data-agent="guide"]').click();
  await until(() => ui.$('[data-agent="guide"]').getAttribute('aria-pressed') === 'true', 'guide selected');
  ui.send('Explain approvals');
  await until(() => ui.streams.length === 3 && ui.$('#chat-stop').hidden, 'guide response');
  assert.equal(ui.chats.get(ui.streams[2].id).mode, 'guide'); assert.equal(ui.streams[2].body.browserContext, undefined);
  assert.equal(ui.$('#chat-history-option').hidden, true);
});

test('late Workspace responses never appear in an App guide conversation and Stop targets the actual running chat', async t => {
  const stopped = []; const ui = await fixture(t, { hold: true, stopped: value => stopped.push(value) });
  ui.send('Private Alpha question'); await until(() => ui.streams.length, 'Workspace stream'); const stream = ui.streams[0];
  const guideChat = ui.create('guide'); guideChat.title = 'Guide only';
  ui.win.location.hash = `#/chat/${guideChat.id}`;
  await until(() => ui.$('[data-agent="guide"]').getAttribute('aria-pressed') === 'true', 'loaded guide');
  ui.enter('Keep the guide draft'); ui.$('#chat-stop').click();
  await until(() => stopped.length, 'Stop route'); assert.equal(stopped[0], stream.id);
  stream.complete('PRIVATE_ALPHA_REPORT');
  await until(() => ui.$('#chat-stop').hidden, 'old response settled');
  assert.equal(ui.$('#chat-thread').textContent.includes('PRIVATE_ALPHA_REPORT'), false);
  assert.equal(ui.$('#chat-input').value, 'Keep the guide draft');
  assert.equal(ui.win.location.hash, `#/chat/${guideChat.id}`);
});

test('leaving Chat during delayed conversation creation does not redirect the reader or lose the saved answer', async t => {
  const gate = deferred(), ui = await fixture(t, { createGate: gate });
  ui.send('Save this background question');
  await until(() => ui.chats.size, 'create started');
  ui.win.location.hash = '#/origin'; ui.view.leave(); gate.resolve();
  await until(() => ui.streams.length && ui.chats.get(ui.streams[0].id).messages.length === 2, 'background answer saved');
  assert.equal(ui.win.location.hash, '#/origin');
  ui.win.location.hash = `#/chat/${ui.streams[0].id}`;
  await until(() => ui.$('.chat-message-assistant'), 'reopened saved answer');
  assert.match(ui.$('#chat-thread').textContent, /Save this background question/); assert.deepEqual(ui.errors, []);
});

test('a changed build labels old answers; source passages and message text render as inert text', async t => {
  const ui = await fixture(t, { hold: true }); ui.send('Explain a source'); await until(() => ui.streams.length, 'stream');
  const stream = ui.streams[0], message = assistant(1, '<img src=x onerror="window.PWNED=1">');
  message.sources = [{ ...doc, title: '<script>window.PWNED=1</script>', text: '<iframe src="https://evil.example"></iframe>' }];
  message.sections[0].text = message.text;
  stream.emit({ type: 'accepted', message: { id: 'user-1', role: 'user', text: 'Explain a source' } }); stream.emit({ type: 'answer', message }); stream.emit({ type: 'done', chat: { id: stream.id, running: false } }); stream.close();
  await until(() => ui.$('#chat-stop').hidden, 'answer finished');
  ui.metadata.build = { version: '0.4.0', id: '0.4.0+changed', fingerprint: 'changed' }; await ui.view.show();
  assert.match(ui.$('#chat-thread').textContent, /older app build/);
  ui.$('.chat-source-buttons button').click();
  assert.equal(ui.$('#chat-thread img, #chat-thread script, #chat-thread iframe'), null); assert.equal(ui.win.PWNED, undefined);
});

test('Delete confirms and removes only the selected saved conversation', async t => {
  const ui = await fixture(t); ui.send('A saved question'); await until(() => ui.$('#chat-stop').hidden && ui.chats.size, 'saved');
  const chatId = [...ui.chats.keys()][0];
  await until(() => ui.$('[data-delete]'), 'history row'); ui.$('[data-delete]').click();
  const dialog = ui.$('dialog'); assert.ok(dialog.open); assert.equal(ui.chats.has(chatId), true);
  [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Delete conversation').click();
  await until(() => !ui.chats.has(chatId), 'deleted');
  assert.equal(ui.requests.filter(row => row.method === 'DELETE').length, 1);
});
