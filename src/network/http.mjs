/**
 * Owner Network routes (/api/network/*), mounted in src/server.mjs behind its unchanged token, Host, Origin, proxy and
 * fetch-site checks. Every route here is also allowed from a paired device (architecture §10.2): none of them creates a
 * way in, shows a secret or changes trust, and none starts work. tests/remote-access.test.mjs scans this file.
 *
 *   GET  /api/network/agents                ?q tag capability status kind provider baseResourceId projectId networkId offset limit
 *   POST /api/network/agents                { baseResourceId, expectedRevision, displayName?, tags?, capabilities?, enabled?, projectAllowlist? }
 *   GET  /api/network/agents/:id
 *   PATCH /api/network/agents/:id           { expectedRevision, …fields }
 *   GET  /api/network/networks              ?q agentId archived=true offset limit
 *   POST /api/network/networks              { name, description?, nodes?, edges? }
 *   GET  /api/network/networks/:id          the draft with refs, issues and usedBy
 *   PATCH /api/network/networks/:id         { expectedRevision, name?, description?, nodes?, edges?, archived? }
 *   DELETE /api/network/networks/:id        { expectedRevision }: only a never-published network nothing uses
 *   POST /api/network/networks/:id/publish  { expectedRevision }
 *   POST /api/network/networks/:id/duplicate { name? }
 *   GET  /api/network/networks/:id/versions/:n
 *   GET  /api/network/export
 *   POST /api/network/import                { data, expectedRevision }
 *
 * Memory of an agent (agents/agt_…) or a network (networks/net_…), and an agent's reports (memory.mjs, posts.mjs):
 *   GET  …/memory                           ?q status offset limit
 *   POST …/memory                           { expectedRevision (of the memory), kind, text }: a proposal
 *   PATCH …/memory/:mid                     { expectedRevision (of the record), kind?, text? }
 *   POST …/memory/:mid/approve              { expectedRevision, decision: 'approve' | 'reject' }
 *   DELETE …/memory/:mid                    { expectedRevision }
 *   GET  /api/network/agents/:id/memory/preview   ?projectId networkId memory=none|agent|agent+network projectLessons=true|false
 *   GET  /api/network/agents/:id/posts      ?offset limit
 *   POST /api/network/agents/:id/posts      { expectedRevision, markdown, references? }
 *   PATCH /api/network/agents/:id/posts/:pid  { expectedRevision, markdown?, references? }
 *   DELETE /api/network/agents/:id/posts/:pid { expectedRevision }
 */
import { NETWORK_LIMITS } from './registry.mjs';
import { NetworkError } from './storage.mjs';

// A draft may reach 8 MiB; an import carries every draft and version (ponytail: one body, split imports past 32 MiB).
const BODY = { small: 64 * 1024, network: NETWORK_LIMITS.draftBytes + 64 * 1024, import: 32 * 1024 * 1024 };
const integer = (value, fallback) => value === null ? fallback : /^\d{1,9}$/.test(value) ? Number(value) : NaN; // NaN is refused by the registry.
const query = (params, keys) => ({ ...Object.fromEntries(keys.map(key => [key, params.get(key) || undefined])), offset: integer(params.get('offset'), 0), limit: integer(params.get('limit'), 50) });
// The preview's question as resolve() takes it; a value it does not know is passed on and refused there.
const preview = params => ({ projectId: params.get('projectId') || null, networkId: params.get('networkId') || null, memory: params.get('memory') || 'agent',
  projectLessons: ({ true: true, false: false, null: false })[params.get('projectLessons')] ?? params.get('projectLessons') });

export async function networkRoute({ network, req, res, pathname, searchParams, jsonBody, send }) {
  const method = req.method;
  const body = async limit => {
    const value = await jsonBody(req, limit);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkError('Send a JSON object.');
    return value;
  };
  try {
    if (pathname === '/api/network/agents') {
      if (method === 'GET') return send(res, 200, await network.listAgents(query(searchParams, ['q', 'tag', 'capability', 'status', 'kind', 'provider', 'baseResourceId', 'projectId', 'networkId'])));
      if (method === 'POST') return send(res, 200, await network.registerAgent(await body(BODY.small)));
    }
    if (pathname === '/api/network/networks') {
      if (method === 'GET') return send(res, 200, await network.listNetworks(query(searchParams, ['q', 'agentId', 'archived'])));
      if (method === 'POST') return send(res, 200, await network.createNetwork(await body(BODY.network)));
    }
    if (method === 'GET' && pathname === '/api/network/export') return send(res, 200, await network.export());
    if (method === 'POST' && pathname === '/api/network/import') return send(res, 200, await network.import(await body(BODY.import)));
    const agent = pathname.match(/^\/api\/network\/agents\/(agt_[0-9a-f]{20})$/);
    if (agent && method === 'GET') return send(res, 200, await network.agent(agent[1]));
    if (agent && method === 'PATCH') return send(res, 200, await network.updateAgent(agent[1], await body(BODY.small)));
    const memory = pathname.match(/^\/api\/network\/(?:agents\/(agt_[0-9a-f]{20})|networks\/(net_[0-9a-f]{20}))\/memory(?:\/(mem_[0-9a-f]{20})(\/approve)?|\/(preview))?$/);
    if (memory) {
      const [, agentId, networkId, recordId, approve, forJob] = memory, kind = agentId ? 'agent' : 'network', id = agentId || networkId;
      if (forJob && agentId && method === 'GET') return send(res, 200, await network.memory.resolve(agentId, preview(searchParams)));
      if (!recordId && !forJob && method === 'GET') return send(res, 200, await network.memory.list(kind, id, query(searchParams, ['q', 'status'])));
      if (!recordId && !forJob && method === 'POST') return send(res, 200, await network.memory.propose(kind, id, await body(BODY.small)));
      if (recordId && approve && method === 'POST') return send(res, 200, await network.memory.decide(kind, id, recordId, await body(BODY.small)));
      if (recordId && !approve && method === 'PATCH') return send(res, 200, await network.memory.edit(kind, id, recordId, await body(BODY.small)));
      if (recordId && !approve && method === 'DELETE') return send(res, 200, await network.memory.remove(kind, id, recordId, await body(BODY.small)));
    }
    const posts = pathname.match(/^\/api\/network\/agents\/(agt_[0-9a-f]{20})\/posts(?:\/(pst_[0-9a-f]{20}))?$/);
    if (posts) {
      const [, agentId, postId] = posts;
      if (!postId && method === 'GET') return send(res, 200, await network.posts.list(agentId, query(searchParams, [])));
      if (!postId && method === 'POST') return send(res, 200, await network.posts.create(agentId, await body(BODY.small)));
      if (postId && method === 'PATCH') return send(res, 200, await network.posts.update(agentId, postId, await body(BODY.small)));
      if (postId && method === 'DELETE') return send(res, 200, await network.posts.remove(agentId, postId, await body(BODY.small)));
    }
    const match = pathname.match(/^\/api\/network\/networks\/(net_[0-9a-f]{20})(?:\/(publish|duplicate)|\/versions\/([1-9]\d{0,8}))?$/);
    if (match) {
      const [, id, action, number] = match;
      if (method === 'GET' && number) return send(res, 200, await network.version(id, Number(number)));
      if (method === 'POST' && action === 'publish') return send(res, 200, await network.publishNetwork(id, await body(BODY.small)));
      if (method === 'POST' && action === 'duplicate') return send(res, 200, await network.duplicateNetwork(id, await body(BODY.small)));
      if (method === 'GET' && !action && !number) return send(res, 200, await network.networkDetail(id));
      if (method === 'PATCH' && !action && !number) return send(res, 200, await network.updateNetwork(id, await body(BODY.network)));
      if (method === 'DELETE' && !action && !number) return send(res, 200, await network.deleteNetwork(id, await body(BODY.small)));
    }
    return send(res, 404, { error: 'This Network route does not exist.', code: 'NOT_FOUND' });
  } catch (error) {
    // Fixed messages; details carry IDs only (a cycle path, unresolved references), never file paths or content.
    if (error instanceof NetworkError) return send(res, error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    throw error;
  }
}
