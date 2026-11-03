/** Explicit instruction/answer tests. No MCP tools, shell execution, memory writes or repository changes. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, removeTempDir, validateEffort } from './providers.mjs';
import { validateRequest } from './engine.mjs';
import { checkModelEffort } from './models.mjs';
import { resolveBase, profileDefaults } from './base-resolver.mjs';
import { prepareBase } from './base-context.mjs';
import { validateAgentOutput } from './base-agent-contract.mjs';

const problem = (message, code = 'BASE_TRIAL_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const operationPattern = /^[A-Za-z0-9_-]{8,100}$/;
const coverage = ['Tests exercise saved instructions, stored knowledge and final-answer checks through the restricted CLI runner.', 'MCP tools, native supporting agents, command recipes, live sources, repository access and memory writes are not exercised. Validate these in the intended Kanban or Network workflow.'];
const projectFor = id => ({ id: 'base_trial', agentProfileId: id });
const trialState = state => ({ ...state, settings: {} });

export class BaseTrials {
  constructor({ board, runner, claim, track, catalog }) { Object.assign(this, { board, runner, claim, track, catalog }); this.operations = new Map(); }
  cancel(id, resourceId) {
    if (!operationPattern.test(id || '')) throw problem('Include a valid test operation ID.');
    const operation = this.operations.get(id);
    if (operation?.resourceId === resourceId) operation.controller.abort();
    return { cancelled: Boolean(operation?.resourceId === resourceId), operationId: id };
  }
  close() { for (const { controller } of this.operations.values()) controller.abort(); }
  async preflight(id) {
    const resource = await this.board.base.detail(id);
    if (!['profile', 'agentProfile'].includes(resource.kind)) throw problem('Choose an agent or agent profile.');
    const state = trialState(await this.board.state()), project = projectFor(id);
    const matrix = [];
    for (const provider of ['claude', 'codex', 'gemini']) for (const columnId of ['planning', 'executing', 'code_review']) {
      const manifest = resolveBase({ state, project, task: {}, provider, columnId });
      matrix.push({ provider, columnId, ready: !manifest.errors.length, errors: manifest.errors, warnings: manifest.warnings,
        resources: manifest.resources.map(({ resourceId, name, delivery, status, issues }) => ({ resourceId, name, delivery, status, issues })) });
    }
    return { expectedRevision: resource.revision, matrix, coverage, note: 'Configuration checks do not contact providers or establish that a CLI is installed or signed in. Actual assignments may add inherited resources.' };
  }
  async run(id, input, { signal } = {}) {
    if (!operationPattern.test(input.operationId || '') || typeof input.question !== 'string' || input.question.length > 8000 || input.question.includes('\0')) throw problem('Include a test operation ID and a question up to 8,000 characters.');
    if (this.operations.has(input.operationId)) throw problem('This test is already running.', 'BUSY', 409);
    const controller = new AbortController(); this.operations.set(input.operationId, { controller, resourceId: id });
    const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    let claimed, abortClaim, cwd;
    try {
      controller.signal.throwIfAborted();
      const resource = await this.board.base.detail(id);
      if (!['profile', 'agentProfile'].includes(resource.kind) || resource.revision !== input.expectedRevision) throw problem('This agent changed. Save and reload it before testing.', 'RESOURCE_REVISION_CONFLICT', 409);
      if (!resource.enabled || resource.trust !== 'trusted') throw problem('Enable and trust the agent before explicitly testing it.', 'BASE_TRUST_REQUIRED', 409);
      const state = trialState(await this.board.state()), agent = profileDefaults(state, id);
      const value = validateRequest({ input: input.question.trim() || 'Run the saved test cases.', provider: agent.provider || 'codex', model: agent.model || '', effort: agent.effort || '' });
      validateEffort(value.provider, value.effort);
      const manifest = resolveBase({ state, project: projectFor(id), task: {}, provider: value.provider, columnId: 'executing' });
      // Trust/availability of the agent identity is mandatory. This limited test deliberately omits capabilities
      // unavailable to the tool-disabled runner, and reports that omission rather than claiming full validation.
      const identityError = manifest.errors.find(error => error.code.startsWith('BASE_PROFILE'));
      if (identityError) throw problem(identityError.message, identityError.code, 409);
      const selected = manifest.resources.filter(entry => entry.status === 'ready' && !['native-mcp', 'native-subagent', 'mcp-tool-reference', 'command-recipe', 'native-skill'].includes(entry.delivery));
      const safeManifest = { ...manifest, errors: [], resources: selected.map(entry => ({ ...entry, required: false })), profiles: manifest.profiles };
      const cases = [...(input.question.trim() ? [{ name: 'Your question', input: input.question.trim(), contains: [], excludes: [] }] : []), ...(resource.configuration.contract?.evaluations || [])];
      if (!cases.length) throw problem('Enter a question or save a test case first.');
      claimed = await this.claim('base-trial', value.provider);
      abortClaim = () => claimed.job.controller.abort(controller.signal.reason); controller.signal.addEventListener('abort', abortClaim, { once: true }); if (controller.signal.aborted) abortClaim();
      Object.assign(claimed.job, { stage: 'base-trial', operationId: input.operationId });
      const bounded = AbortSignal.any([claimed.job.controller.signal, AbortSignal.timeout(Math.min(180000, manifest.requirements?.timeoutMs ?? 180000))]);
      if (value.effort) checkModelEffort(value.provider, value.model, value.effort, await this.catalog(value.provider));
      bounded.throwIfAborted(); cwd = await makeTempDir('promptboard-base-test-'); const runDir = join(cwd, '.base-test'); await mkdir(runDir, { mode: 0o700 });
      const delivery = await prepareBase({ manifest: safeManifest, currentResources: state.base.resources, approvedRoots: [], workspacePath: cwd, runDir, signal: bounded,
        readRevision: async ref => {
          const definition = structuredClone(await this.board.base.readRevision(ref));
          if (definition.configuration?.sources) definition.configuration.sources = [];
          definition.dependencies = [];
          return definition;
        } });
      const results = [];
      for (const test of cases) {
        bounded.throwIfAborted();
        const prompt = `This is an instruction and final-answer test in an empty temporary folder. Answer the user's question using the saved instructions and supplied reference text. Tools, commands, external sources and memory are unavailable. Do not claim to have used them.\n\n${delivery.sections}\n\nQuestion:\n${test.input}`;
        const response = await this.track(this.runner({ provider: value.provider, model: value.model, effort: value.effort, prompt, cwd, signal: bounded, timeoutMs: 180000 }));
        bounded.throwIfAborted();
        if (typeof response.text !== 'string' || response.text.length > 500000) throw problem('The CLI answer exceeds the test output limit.', 'BASE_TRIAL_OUTPUT', 502);
        results.push({ name: test.name, answer: response.text, validation: validateAgentOutput(response.text, [...(manifest.contracts || []), { checks: { contains: test.contains, excludes: test.excludes } }]) });
      }
      const current = await this.board.state();
      for (const entry of [...manifest.profiles, ...selected]) if (current.base.resources.find(r => r.id === entry.resourceId)?.revision !== entry.revision) throw problem('A selected agent or resource changed during this test. Run the test again.', 'RESOURCE_REVISION_CONFLICT', 409);
      return { operationId: input.operationId, expectedRevision: resource.revision, provider: value.provider, results, coverage,
        revisions: [...manifest.profiles, ...selected].map(({ resourceId, revision }) => ({ resourceId, revision })) };
    } finally {
      try { if (cwd) await removeTempDir(cwd); }
      finally { this.operations.delete(input.operationId); signal?.removeEventListener('abort', abort); if (abortClaim) controller.signal.removeEventListener('abort', abortClaim); claimed?.release(); }
    }
  }
}
