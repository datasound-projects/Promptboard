/** Protected Base routes, mounted after the server's local-origin and token checks. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseError, BASE_LIMITS, normalizeContent } from './base.mjs';
import { captureSources, fetchDocument, searchSources } from './base-context.mjs';
import { CONTEXT7_PRESET, testMcp } from './base-mcp.mjs';
import { WikiJobs } from './base-wiki.mjs';

const fail = (message, code = 'BASE_INVALID_INPUT', status = 400) => { throw new BaseError(message, code, status); };
const sameTarget = (a, b) => ['scope', 'projectId', 'taskId', 'columnId'].every(key => a?.[key] === b?.[key]);

export class BaseRoutes {
  constructor({ board, runner, claim, track, catalog, send, jsonBody, mcpTester = testMcp }) {
    Object.assign(this, { board, track, send, jsonBody, mcpTester });
    this.wiki = new WikiJobs({ board, runner, claim, track, catalog });
    this.operations = new Set();
  }

  close() { this.wiki.close(); for (const controller of this.operations) controller.abort(); }

  async body(req) {
    const body = await this.jsonBody(req, BASE_LIMITS.importBytes);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Send a JSON object.');
    return body;
  }

  async changed(res, result = {}) { this.send(res, 200, { ...result, ...await this.board.baseView(), board: await this.board.view() }); }

  async bounded(res, work) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); this.operations.add(controller);
    try { return await this.track(work(signal)); }
    finally { res.off('close', abort); this.operations.delete(controller); }
  }

  async route(req, res, pathname, search) {
    const { board } = this, method = req.method;
    if (method === 'GET' && pathname === '/api/base') return this.send(res, 200, await board.baseView());
    if (method === 'GET' && pathname === '/api/base/presets') return this.send(res, 200, { presets: [CONTEXT7_PRESET] });
    if (method === 'GET' && pathname === '/api/base/target') {
      let target; try { target = JSON.parse(search.get('target')); } catch { fail('Choose a valid target.'); }
      const item = (await board.baseView()).targets.find(item => sameTarget(item.target, target));
      if (!item) fail('This assignment target no longer exists.', 'BASE_TARGET_NOT_FOUND', 404);
      return this.send(res, 200, item);
    }
    if (method === 'POST' && pathname === '/api/base/preview') return this.send(res, 200, await board.previewBase(await this.body(req)));
    if (method === 'POST' && pathname === '/api/base/apply') {
      const body = await this.body(req);
      if (!Number.isSafeInteger(body.expectedBaseRevision) || !Array.isArray(body.changes) || body.changes.some(change => !Number.isSafeInteger(change?.expectedRevision))) fail('Include the Base revision and each target revision from the assignment preview.', 'BASE_REVISION_REQUIRED');
      return this.changed(res, { applied: await board.base.apply(body) });
    }
    if (method === 'POST' && pathname === '/api/base/restore-global') return this.changed(res, { restored: await board.restoreBaseGlobals(await this.body(req)) });
    if (method === 'POST' && pathname === '/api/base/skills/import') {
      const body = await this.body(req);
      return this.changed(res, { resource: await board.base.importSkill(body, body) });
    }
    if (method === 'POST' && pathname === '/api/base/resources') {
      const body = await this.body(req);
      return this.changed(res, { resource: await board.base.create(body.resource || body, body) });
    }
    if (method === 'POST' && pathname === '/api/base/import/preview') return this.send(res, 200, await board.base.previewImport((await this.body(req)).data));
    if (method === 'POST' && pathname === '/api/base/import') {
      const body = await this.body(req);
      return this.changed(res, { imported: await board.base.import(body.data, body) });
    }
    if (method === 'POST' && pathname === '/api/base/export') {
      const body = await this.body(req);
      return this.send(res, 200, await board.base.export({ ids: body.resourceIds, includeContent: body.includeContent === true }));
    }
    if (method === 'POST' && pathname === '/api/base/roots') {
      const body = await this.body(req);
      return this.changed(res, { root: await board.base.approveRoot(body.path, body) });
    }
    const rootMatch = pathname.match(/^\/api\/base\/roots\/([A-Za-z0-9_-]{1,100})$/);
    if (method === 'DELETE' && rootMatch) return this.changed(res, { root: await board.base.revokeRoot(rootMatch[1], await this.body(req)) });
    if (method === 'POST' && pathname === '/api/base/wiki/cancel') return this.send(res, 200, this.wiki.cancel((await this.body(req)).operationId));
    if (method === 'POST' && pathname === '/api/base/wiki/generate') {
      const body = await this.body(req), controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', abort);
      try { return this.send(res, 200, await this.track(this.wiki.generate(body, { signal: controller.signal }))); }
      finally { res.off('close', abort); }
    }
    if (method === 'POST' && pathname === '/api/base/wiki/apply') return this.changed(res, { resource: await this.wiki.apply(await this.body(req)) });
    // URL imports return inert text for review. Saving/assigning remains a separate explicit action.
    if (method === 'POST' && pathname === '/api/base/source/import') {
      const body = await this.body(req);
      return this.send(res, 200, { source: await this.bounded(res, signal => fetchDocument(body.url, { signal })) });
    }
    const match = pathname.match(/^\/api\/base\/resources\/([A-Za-z0-9_-]{1,100})(?:\/(test|refresh|search|revisions)(?:\/([0-9]+))?)?$/);
    if (match) {
      const [, id, action, revision] = match;
      if (method === 'GET' && (!action || action === 'revisions')) return this.send(res, 200, { resource: await board.base.detail(id, { revision }) });
      if (method === 'PATCH' && !action) {
        const body = await this.body(req);
        return this.changed(res, { resource: await board.base.update(id, body.resource || body, body) });
      }
      if (method === 'DELETE' && !action) {
        const body = req.headers['content-type'] ? await this.body(req) : { expectedRevision: Number(search.get('expectedRevision')), expectedBaseRevision: Number(search.get('expectedBaseRevision')), detach: search.get('detach') === 'true' };
        return this.changed(res, { removed: await board.base.remove(id, body) });
      }
      if (method === 'POST' && action === 'test') {
        const body = await this.body(req), resource = await board.base.detail(id);
        if (resource.kind !== 'mcp' || resource.trust !== 'trusted') fail('Trust this MCP server before explicitly testing its connection.', 'BASE_TRUST_REQUIRED', 409);
        if (resource.revision !== body.expectedRevision) fail('This resource changed. Reload it before testing.', 'RESOURCE_REVISION_CONFLICT', 409);
        let result;
        try { result = await this.bounded(res, signal => this.mcpTester(resource, { signal })); }
        catch (error) {
          await board.base.recordConnectionTest(id, { status: 'failed', code: error.code || 'BASE_MCP_FAILED' }, { expectedRevision: resource.revision });
          throw error;
        }
        await board.base.recordConnectionTest(id, result, { expectedRevision: resource.revision });
        return this.changed(res, { result, resource: await board.base.detail(id) });
      }
      if (method === 'POST' && action === 'refresh') {
        const body = await this.body(req), resource = await board.base.detail(id);
        if (!['context', 'knowledge'].includes(resource.kind)) fail('Choose a context source or knowledge collection.');
        if (!resource.configuration?.sources?.length) fail('This resource has no live source rules. Pasted text and uploaded files are edited in the resource itself.', 'BASE_NO_REFRESH_SOURCE');
        if (resource.revision !== body.expectedRevision) fail('This source changed. Reload it before refreshing.', 'RESOURCE_REVISION_CONFLICT', 409);
        const state = await board.state();
        const project = body.projectId ? state.projects.find(project => project.id === body.projectId) : null;
        if (body.projectId && !project) fail('Choose an existing project for repository sources.');
        const captured = await this.bounded(res, signal => captureSources(resource, { workspacePath: project?.repository?.root, approvedRoots: state.base.approvedRoots, signal,
          readRevision: ref => board.base.readRevision(ref), resources: state.base.resources }));
        const updated = await board.base.update(id, { content: { ...resource.content, sources: captured.sources } }, { expectedRevision: resource.revision, expectedBaseRevision: body.expectedBaseRevision });
        return this.changed(res, { resource: updated, omitted: captured.omitted });
      }
      if (method === 'GET' && action === 'search') {
        const resource = await board.base.detail(id), content = normalizeContent(resource.content);
        const sources = [...content.sources, ...content.pages.map(page => ({ id: page.id, name: page.title, text: page.markdown, provenance: page.provenance }))];
        if (content.body) sources.unshift({ id: resource.id, name: resource.name, text: content.body });
        const result = searchSources(sources, (search.get('q') || '').slice(0, 500), { budgetChars: 12000 });
        return this.send(res, 200, { ...result, results: result.selected });
      }
    }
    const runMatch = pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]{1,100})\/(base|base-context|base-definition)$/);
    if (method === 'GET' && runMatch) {
      const run = await board.run(runMatch[1]);
      if (runMatch[2] === 'base') return this.send(res, 200, { manifest: run.baseManifest || null, planBaseChanged: run.planBaseChanged === true });
      const id = search.get('resourceId');
      if (runMatch[2] === 'base-definition') {
        const pinned = [...(run.baseManifest?.resources || []), ...(run.baseManifest?.profiles || [])].find(item => item.resourceId === id);
        if (!pinned?.revisionRef) fail('This resource was not configured for this run.', 'BASE_NOT_FOUND', 404);
        return this.send(res, 200, { resource: await board.base.readRevision(pinned.revisionRef) });
      }
      const supplied = run.baseManifest?.supplied?.find(item => item.resourceId === id);
      if (!supplied?.contextRef || !/^base-context\/[A-Za-z0-9_-]+\.txt$/.test(supplied.contextRef)) fail('This run has no supplied context for that resource.', 'BASE_NOT_FOUND', 404);
      const text = await readFile(join(board.dataDir, run.artifactsDir, supplied.contextRef), 'utf8');
      return this.send(res, 200, { resourceId: id, text, contentHash: supplied.contentHash });
    }
    return false;
  }
}
