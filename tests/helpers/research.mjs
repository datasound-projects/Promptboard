// Shared setup for Origin Research browser tests: a test server, an Origin project with a renamed section,
// a custom section and a component, and Chrome open on Origin.
import assert from 'node:assert/strict';
import '../../public/origin-model.js';
import { launch } from './browser.mjs';
import { startTestServer } from './test-server.mjs';

const M = globalThis.PromptboardOriginModel;
const J = JSON.stringify;

/** An Origin project with a renamed section, a custom section and a component; the page open on Origin. */
export async function researchPage(t, { runner = async () => { throw new Error('No model call is expected.'); }, width = 1440, height = 900, blueprint: extend = () => {}, server = {} } = {}) {
  const calls = [];
  const app = await startTestServer(t, { port: 0, executor: null, detector: async () => [{ id: 'claude', available: true, version: '2.1.296' }, { id: 'codex', available: true, version: '0.160.0' }],
    authAdapter: { installed: async () => true, status: async () => ({ state: 'signed-in' }) }, runner: async call => { calls.push(call); return runner(call); },
    catalogReader: async provider => ({ provider, models: [{ id: provider === 'claude' ? 'sonnet' : 'gpt-5.5', name: provider === 'claude' ? 'Sonnet' : 'GPT-5.5', efforts: ['low', 'high'] }] }), ...server });
  const token = (await (await fetch(`${app.url}/api/session`)).json()).token;
  const send = (path, method, body) => fetch(`${app.url}${path}`, { method, headers: { 'X-STE-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: J(body) } : {}) });
  // A reused keep-alive socket the server closed while idle fails before any reply; a GET is sent once more.
  const call = (path, method = 'GET', body) => send(path, method, body).catch(error => { if (method !== 'GET' || error?.cause?.code !== 'UND_ERR_SOCKET') throw error; return send(path, method, body); }).then(response => response.json());
  const created = await call('/api/origin/projects', 'POST', { name: 'Shop' });
  const blueprint = M.emptyBlueprint();
  blueprint.idea = 'An online shop for handmade goods';
  blueprint.labels.sections.technology = 'Stack';
  blueprint.customSections.push({ id: 'pricing', phase: 'decide', title: 'Pricing model', description: 'How we charge', notApplicable: false });
  blueprint.components.push({ id: 'c1', origin: 'human', name: 'Checkout API', type: 'api', purpose: 'Takes payments', responsibilities: '', technologyIds: [], interfaces: '', dataHandled: '', status: 'draft', notes: '', sourceIds: [], x: 0, y: 0, layerId: null, answers: {} });
  extend(blueprint);
  const saved = await call(`/api/origin/projects/${created.project.id}`, 'PUT', { expectedRevision: created.project.revision ?? 1, blueprint });
  const browser = await launch({ width, height }); assert.ok(browser); t.after(() => browser.close());
  // CI runners can give headless Chrome a smaller window than requested; width matters for the panel, so set it.
  await browser.resize(width, height);
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (!sessionStorage.getItem('seeded')) { localStorage.setItem('promptboard.origin.project', ${J(created.project.id)}); sessionStorage.setItem('seeded', '1'); }` });
  await browser.goto(`${app.url}/#/origin`);
  const ev = code => browser.eval(code), wait = (expression, label, ms = 15000) => browser.until(expression, label, ms);
  await wait(`document.querySelector('#origin-view').dataset.save === 'saved' && !document.querySelector('#origin-research-open').hidden`, 'Origin loaded');
  return { app, browser, ev, wait, call, calls, originId: created.project.id, revision: saved.revision };
}
export const drawerState = ev => ev(`const d = document.querySelector('#origin-drawer'), r = d.getBoundingClientRect(); return { mode: d.dataset.mode || null, hidden: d.hidden, width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), mini: !document.querySelector('#origin-research-mini').hidden };`);

