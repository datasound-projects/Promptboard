/**
 * Owner Network routes (/api/network/*), mounted in src/server.mjs behind its unchanged token, Host, Origin, proxy and
 * fetch-site checks. Every route here is also allowed from a paired device (architecture §10.2): none of them creates a
 * way in, shows a secret or changes trust, and none starts work. tests/remote-access.test.mjs scans this file.
 *
 *   GET  /api/network/agents                ?q tag capability status baseResourceId projectId networkId offset limit
 *   POST /api/network/agents                { baseResourceId, expectedRevision, displayName?, tags?, capabilities?, enabled?, projectAllowlist? }
 *   GET  /api/network/agents/:id
 *   PATCH /api/network/agents/:id           { expectedRevision, …fields }
 *   GET  /api/network/networks              ?q agentId offset limit
 *   POST /api/network/networks              { name, description?, nodes?, edges? }
 *   GET  /api/network/networks/:id
 *   PATCH /api/network/networks/:id         { expectedRevision, name?, description?, nodes?, edges? }
 *   POST /api/network/networks/:id/publish  { expectedRevision }
 *   GET  /api/network/networks/:id/versions/:n
 *   GET  /api/network/export
 *   POST /api/network/import                { data, expectedRevision }
 */
import { NETWORK_LIMITS } from './registry.mjs';
import { NetworkError } from './storage.mjs';

// A draft may reach 8 MiB; an import carries every draft and version (ponytail: one body, split imports past 32 MiB).
const BODY = { small: 64 * 1024, network: NETWORK_LIMITS.draftBytes + 64 * 1024, import: 32 * 1024 * 1024 };
const integer = (value, fallback) => value === null ? fallback : /^\d{1,9}$/.test(value) ? Number(value) : NaN; // NaN is refused by the registry.
const query = (params, keys) => ({ ...Object.fromEntries(keys.map(key => [key, params.get(key) || undefined])), offset: integer(params.get('offset'), 0), limit: integer(params.get('limit'), 50) });

export async function networkRoute({ network, req, res, pathname, searchParams, jsonBody, send }) {
  const method = req.method;
  const body = async limit => {
    const value = await jsonBody(req, limit);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkError('Send a JSON object.');
    return value;
  };
  try {
    if (pathname === '/api/network/agents') {
      if (method === 'GET') return send(res, 200, await network.listAgents(query(searchParams, ['q', 'tag', 'capability', 'status', 'baseResourceId', 'projectId', 'networkId'])));
      if (method === 'POST') return send(res, 200, await network.registerAgent(await body(BODY.small)));
    }
    if (pathname === '/api/network/networks') {
      if (method === 'GET') return send(res, 200, await network.listNetworks(query(searchParams, ['q', 'agentId'])));
      if (method === 'POST') return send(res, 200, await network.createNetwork(await body(BODY.network)));
    }
    if (method === 'GET' && pathname === '/api/network/export') return send(res, 200, await network.export());
    if (method === 'POST' && pathname === '/api/network/import') return send(res, 200, await network.import(await body(BODY.import)));
    const agent = pathname.match(/^\/api\/network\/agents\/(agt_[0-9a-f]{20})$/);
    if (agent && method === 'GET') return send(res, 200, await network.agent(agent[1]));
    if (agent && method === 'PATCH') return send(res, 200, await network.updateAgent(agent[1], await body(BODY.small)));
    const match = pathname.match(/^\/api\/network\/networks\/(net_[0-9a-f]{20})(?:\/(publish)|\/versions\/([1-9]\d{0,8}))?$/);
    if (match) {
      const [, id, action, number] = match;
      if (method === 'GET' && number) return send(res, 200, await network.version(id, Number(number)));
      if (method === 'POST' && action === 'publish') return send(res, 200, await network.publishNetwork(id, await body(BODY.small)));
      if (method === 'GET' && !action && !number) return send(res, 200, await network.network(id));
      if (method === 'PATCH' && !action && !number) return send(res, 200, await network.updateNetwork(id, await body(BODY.network)));
    }
    return send(res, 404, { error: 'This Network route does not exist.', code: 'NOT_FOUND' });
  } catch (error) {
    // Fixed messages; details carry IDs only (a cycle path, unresolved references), never file paths or content.
    if (error instanceof NetworkError) return send(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    throw error;
  }
}
