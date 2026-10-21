/** Protected Base routes, mounted after the server's local-origin and token checks. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BaseError, BASE_LIMITS, normalizeContent, normalizeResource } from './base.mjs';
import { captureSources, fetchDocument, searchSources } from './base-context.mjs';
import { CONTEXT7_PRESET, testMcp } from './base-mcp.mjs';
import { WikiJobs } from './base-wiki.mjs';
import { AvatarJobs } from './base-avatar.mjs';
import { MARKDOWN_TEMPLATES, deployToRepository, markdownConvention, markdownFrontmatter, readRepositoryFile, scanRepository } from './base-markdown.mjs';
import { mcpResourceFrom, parseMcpConfig, readMcpSource } from './base-mcp-import.mjs';
const digest = text => createHash('sha256').update(text).digest('hex');

const fail = (message, code = 'BASE_INVALID_INPUT', status = 400) => { throw new BaseError(message, code, status); };

export class BaseRoutes {
  constructor({ board, runner, claim, track, catalog, send, jsonBody, mcpTester = testMcp, imageGenerator }) {
    Object.assign(this, { board, track, send, jsonBody, mcpTester });
    this.wiki = new WikiJobs({ board, runner, claim, track, catalog });
    this.avatars = new AvatarJobs({ board, claim, track, imageGenerator });
    this.operations = new Set();
  }

  close() { this.wiki.close(); this.avatars.close(); for (const controller of this.operations) controller.abort(); }

  async body(req) {
    // An import carries a whole export (up to BASE_LIMITS.importBytes) inside its request; 1 MiB is left for the wrapper and ID remap.
    const body = await this.jsonBody(req, BASE_LIMITS.importBytes + 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Send a JSON object.');
    return body;
  }

  async changed(res, result = {}) { this.send(res, 200, { ...result, ...await this.board.baseView(), board: await this.board.view() }); }

  async bounded(res, work) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); if (res.destroyed) controller.abort(); this.operations.add(controller);
    try { return await this.track(work(signal)); }
    finally { res.off('close', abort); this.operations.delete(controller); }
  }

  async route(req, res, pathname, search) {
    const { board } = this, method = req.method;
    if (method === 'GET' && pathname === '/api/base') return this.send(res, 200, await board.baseView());
    if (method === 'GET' && pathname === '/api/base/presets') return this.send(res, 200, { presets: [CONTEXT7_PRESET] });
    if (method === 'POST' && pathname === '/api/base/avatar/cancel') return this.send(res, 200, this.avatars.cancel((await this.body(req)).operationId));
    if (method === 'POST' && pathname === '/api/base/avatar/generate') {
      const body = await this.body(req), controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', abort); if (res.destroyed) controller.abort();
      try { return this.send(res, 200, await this.track(this.avatars.generate(body, { signal: controller.signal }))); }
      finally { res.off('close', abort); }
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
      res.once('close', abort); if (res.destroyed) controller.abort();
      try { return this.send(res, 200, await this.track(this.wiki.generate(body, { signal: controller.signal }))); }
      finally { res.off('close', abort); }
    }
    if (method === 'POST' && pathname === '/api/base/wiki/apply') return this.changed(res, { resource: await this.wiki.apply(await this.body(req)) });
    // URL imports return inert text for review. Saving/assigning remains a separate explicit action.
    if (method === 'POST' && pathname === '/api/base/source/import') {
      const body = await this.body(req);
      return this.send(res, 200, { source: await this.bounded(res, signal => fetchDocument(body.url, { signal })) });
    }
    // ---- Custom Markdown files: starting points, and the instruction files a project's repository already has ----
    if (method === 'GET' && pathname === '/api/base/markdown/templates') return this.send(res, 200, { templates: MARKDOWN_TEMPLATES.map(template => ({ ...template, convention: markdownConvention(template.fileName) })) });
    if (method === 'POST' && (pathname === '/api/base/markdown/scan' || pathname === '/api/base/markdown/import')) {
      const body = await this.body(req), project = (await board.state()).projects.find(item => item.id === body.projectId);
      const root = project?.repository?.root;
      if (!root) fail('Choose a project linked to a folder.', 'REPOSITORY_REQUIRED', 409);
      const found = await scanRepository(root), library = await board.base.list();
      const existing = await Promise.all(library.resources.filter(resource => ['markdown', 'skill'].includes(resource.kind)).map(async resource => ({ resource, detail: await board.base.detail(resource.id).catch(() => null) })));
      // A skill keeps no repository path: it is known by its SKILL.md text. Other files are known by their name.
      const skillText = item => item.detail?.content.files?.find(file => file.path === 'SKILL.md')?.text;
      const known = (path, text) => markdownConvention(path).id === 'skill' ? existing.find(item => item.resource.kind === 'skill' && text !== undefined && skillText(item) === text)
        : existing.find(item => item.resource.kind === 'markdown' && item.detail?.configuration.fileName === path && item.detail.content.body);
      if (pathname.endsWith('/scan')) return this.send(res, 200, { project: { id: project.id, name: project.name }, files: await Promise.all(found.map(async file => ({ ...file,
        inBase: Boolean(known(file.path, file.convention === 'skill' ? await readRepositoryFile(root, file.path).catch(() => undefined) : undefined)) }))) });
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 100) fail('Choose up to 100 files to import.');
      const imported = [], skipped = [];
      for (const path of body.paths) {
        // Only what the scan finds can be read: a path from the page never reaches the filesystem otherwise.
        if (typeof path !== 'string' || !found.some(file => file.path === path)) { skipped.push({ path, reason: 'Not an instruction file found in this repository.' }); continue; }
        // A file Base refuses (a SKILL.md without frontmatter, say) is skipped by name; the others are still imported.
        try {
          const text = await readRepositoryFile(root, path), duplicate = known(path, text);
          if (duplicate && (markdownConvention(path).id === 'skill' || digest(duplicate.detail.content.body) === digest(text))) { skipped.push({ path, reason: `Already in Base as “${duplicate.resource.name}”.` }); continue; }
          if (markdownConvention(path).id === 'skill') { imported.push(await board.base.importSkill({ markdown: text, tags: ['imported'] })); continue; }
          imported.push(await board.base.create({ kind: 'markdown', name: path, description: `Imported from ${project.name} (${path}). Review it before trusting it: it instructs agents.`, enabled: false, trust: 'untrusted', tags: ['imported'],
            configuration: { fileName: path, activation: { mode: 'always' } }, content: { body: text } }));
        } catch (error) { if (!(error.status < 500)) throw error; skipped.push({ path, reason: `${path}: ${error.message}` }); }
      }
      return this.changed(res, { imported: imported.map(resource => ({ id: resource.id, name: resource.name, kind: resource.kind })), skipped });
    }
    // ---- MCP servers from an existing configuration (pasted, or Claude Desktop's own file on this computer) ----
    if (method === 'POST' && (pathname === '/api/base/mcp/import/preview' || pathname === '/api/base/mcp/import')) {
      const body = await this.body(req);
      const source = body.source ? await readMcpSource(body.source) : { path: null, text: typeof body.json === 'string' ? body.json : fail('Paste a configuration or choose Claude Desktop.') };
      if (source.text.length > 1_000_000) fail('The configuration is larger than 1 MB.');
      const library = await board.base.list(), existing = await Promise.all(library.resources.filter(resource => resource.kind === 'mcp').map(resource => board.base.detail(resource.id).catch(() => null)));
      const parsed = parseMcpConfig(source.text, { existing: existing.filter(Boolean) }), from = source.path ? 'Claude Desktop' : 'a pasted configuration';
      // Base's own checks too, so the preview shows exactly what the import accepts.
      for (const server of parsed.servers.filter(item => item.importable)) { try { normalizeResource(mcpResourceFrom(server, from)); } catch (error) { if (!(error instanceof BaseError)) throw error; server.importable = false; server.issues.push(error.message); } }
      if (pathname.endsWith('/preview')) return this.send(res, 200, { source: source.path ? 'Claude Desktop' : 'pasted configuration', path: source.path, ...parsed });
      const wanted = new Set(Array.isArray(body.names) ? body.names : []), chosen = parsed.servers.filter(item => wanted.has(item.name)), created = [];
      // Every chosen server is checked before any is created: a refused one leaves nothing half-imported.
      for (const server of chosen) if (!server.importable) fail(`“${server.name}” cannot be imported: ${server.duplicateOf ? `it is already in Base as “${server.duplicateOf.name}”.` : server.issues.join(' ')}`);
      for (const server of chosen) created.push(await board.base.create(mcpResourceFrom(server, from)));
      return this.changed(res, { imported: created.map(resource => ({ id: resource.id, name: resource.name })) });
    }
    const match = pathname.match(/^\/api\/base\/resources\/([A-Za-z0-9_-]{1,100})(?:\/(test|refresh|search|revisions|avatar|deploy|override)(?:\/([0-9]+))?)?$/);
    if (match) {
      const [, id, action, revision] = match;
      if (method === 'GET' && action === 'avatar') {
        const resource = await board.base.detail(id);
        if (resource.kind !== 'profile' || !resource.content.avatar) fail('This profile has no saved avatar.', 'BASE_NOT_FOUND', 404);
        return this.send(res, 200, { image: resource.content.avatar });
      }
      if (method === 'GET' && (!action || action === 'revisions')) {
        const resource = await board.base.detail(id, { revision });
        // A Markdown file shows its convention and frontmatter problems next to its text.
        if (resource.kind === 'markdown') resource.markdown = { convention: markdownConvention(resource.configuration.fileName), ...markdownFrontmatter(resource.content.body || '', resource.configuration.fileName), chars: (resource.content.body || '').length, estimatedTokens: Math.ceil((resource.content.body || '').length / 4) };
        return this.send(res, 200, { resource });
      }
      if (method === 'POST' && action === 'override') {
        // A project's own version of a shared file: the shared file stays as it is for every other project.
        const body = await this.body(req), shared = await board.base.detail(id), state = await board.state();
        if (shared.kind !== 'markdown' || shared.configuration.override) fail('Only a shared Markdown file gets project versions.');
        const project = state.projects.find(item => item.id === body.projectId);
        if (!project) fail('Choose a project.');
        // A copy of the shared text keeps its trust: an imported file still waits for review in the project's version.
        return this.changed(res, { resource: await board.base.create({ kind: 'markdown', name: `${shared.name} · ${project.name}`, description: `${project.name}’s version of “${shared.name}”.`, tags: shared.tags, trust: shared.trust,
          configuration: { ...shared.configuration, override: { of: shared.id, projectId: project.id } }, content: { body: shared.content.body } }) });
      }
      if (method === 'POST' && action === 'deploy') {
        // Put the file at its place in a project's repository, so a CLI that reads it natively finds it there.
        const body = await this.body(req), resource = await board.base.detail(id), project = (await board.state()).projects.find(item => item.id === body.projectId);
        if (resource.kind !== 'markdown') fail('Only Markdown files are written into repositories.');
        if (!project?.repository?.root) fail('Choose a project linked to a folder.', 'REPOSITORY_REQUIRED', 409);
        if (body.confirm === true && resource.trust !== 'trusted') fail('Trust this file before writing it into a repository.', 'BASE_TRUST_REQUIRED', 409);
        return this.send(res, 200, { deploy: await deployToRepository(project.repository.path || project.repository.root, resource.configuration.fileName, resource.content.body || '', { confirm: body.confirm === true, expectedHash: body.expectedHash ?? null, hash: digest }) });
      }
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
        // Refresh owns only its captures. Pasted, uploaded, and independently imported
        // sources remain intact; removed live sources disappear on the next refresh.
        const live = [...new Map(captured.sources.map(source => [source.id, source])).values()].map(source => ({ ...source,
          id: `refresh_${createHash('sha256').update(source.id).digest('hex').slice(0, 32)}`,
          provenance: { ...source.provenance, method: 'refresh' } }));
        const sources = [...resource.content.sources.filter(source => source.provenance?.method !== 'refresh'), ...live];
        const updated = await board.base.update(id, { content: { ...resource.content, sources } }, { expectedRevision: resource.revision, expectedBaseRevision: body.expectedBaseRevision });
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
      const text = await readFile(join(board.dataDir, run.artifactsDir, supplied.contextRef), 'utf8').catch(error => {
        if (error.code === 'ENOENT') fail('The supplied context of this run is no longer stored.', 'BASE_NOT_FOUND', 404);
        throw error;
      });
      return this.send(res, 200, { resourceId: id, text, contentHash: supplied.contentHash });
    }
    return false;
  }
}
