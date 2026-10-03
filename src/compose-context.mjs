import { validateRequest } from './engine.mjs';
import { makeTempDir, removeTempDir, validateEffort } from './providers.mjs';
import { invalid, object, list, string } from './compose-grounding.mjs';
import { NO_TASK, obviouslyNonActionable } from './compose-intent.mjs';
import { ComposeDocuments } from './compose-documents.mjs';
import { ComposeMcp, validateMcp } from './compose-mcp.mjs';
import { ComposeLocal, validateLocal } from './compose-local.mjs';
import { buildIndex, chunkPages, search, budgetEvidence, terms } from './compose-retrieval.mjs';
import { RESEARCH_LIMITS, safeExternalQuery, validateResearchPlan, buildResearchPrompt, buildResearchReviewPrompt, validateResearchReview, researchGrounding } from './compose-research.mjs';

export function validatePreparation(body) {
  object(body, ['request', 'autonomous', 'clarify', 'sources'], 'preparation');
  const request = validateRequest(body.request);
  if (request.grounding) invalid('Prepare the original task without an existing grounding payload.');
  const autonomous = body.autonomous ?? body.clarify ?? true;
  if (typeof autonomous !== 'boolean' || (body.clarify !== undefined && typeof body.clarify !== 'boolean')) invalid('Choose whether to research autonomously.');
  const sources = list(body.sources ?? [], 8, 'context sources').map(source => {
    if (source?.type === 'mcp') return validateMcp(source);
    if (source?.type === 'local') return validateLocal(source);
    if (source?.type === 'document') {
      object(source, ['type', 'id'], 'document source'); string(source.id, 80, 'document ID'); return source;
    }
    if (source?.type === 'expert') {
      object(source, ['type', 'name', 'text'], 'expert context');
      string(source.name, 80, 'context name'); string(source.text, 20_000, 'expert context'); return source;
    }
    invalid('Unknown context source.');
  });
  if (sources.filter(source => source.type === 'mcp').length > 3) invalid('Use at most three MCP sources.');
  return { request, autonomous, sources };
}
// Compatibility export for callers that built the previous planning prompt.
export const buildPlanPrompt = buildResearchPrompt;
const priority = source => source.type === 'local' ? 0 : source.type === 'expert' ? 1 : source.type === 'document' ? 2 : source.preset === 'context7' ? 3 : 4;
const relevant = (query, source, row) => ['all', source.type, source.kind, source.preset, row.name.toLowerCase()].includes(query.sourceHint.toLowerCase());
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class ComposeContext {
  constructor({ documents = new ComposeDocuments(), mcp = new ComposeMcp(), local = new ComposeLocal() } = {}) { this.documents = documents; this.mcp = mcp; this.local = local; }
  close() { this.documents.close(); this.mcp.close?.(); this.local.close(); }
  async prepare(body, { runner, signal, onStage = () => {}, timeoutMs = 240_000 } = {}) {
    const { request, autonomous, sources } = validatePreparation(body);
    const empty = { evidence: [], warnings: [], sources: [], calls: 0, research: { lookups: 0, rounds: 0 } };
    if (obviouslyNonActionable(request.input)) return { ...empty, state: 'non-actionable', message: NO_TASK[request.language] };
    if (!autonomous && !sources.length) return { ...empty, state: 'ready', grounding: {} };
    validateEffort(request.provider, request.effort);
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new DOMException('Research time budget expired.', 'TimeoutError')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const started = Date.now(), warnings = [], usable = [], descriptions = [], outcomes = new Map(), seen = new Set(), candidates = [];
    let calls = 0, lookups = 0, rounds = 0, plan, review;
    const model = async prompt => {
      combined.throwIfAborted();
      if (calls >= 4) throw new Error('Planning call budget reached.');
      const cwd = await makeTempDir('ste-compose-research-');
      const duration = Math.min(90_000, Math.max(1, timeoutMs - (Date.now() - started)));
      const modelSignal = AbortSignal.any([combined, AbortSignal.timeout(duration)]);
      try {
        modelSignal.throwIfAborted();
        calls++;
        const result = await abortable(runner({ provider: request.provider, model: request.model, effort: request.effort, cwd, signal: modelSignal, timeoutMs: duration, prompt }), modelSignal);
        combined.throwIfAborted(); return result.text;
      } finally { await removeTempDir(cwd); }
    };
    const evidence = () => budgetEvidence(candidates);
    try {
      combined.throwIfAborted();
      // Metadata only: no files, MCP connections or document reads before intent assessment.
      for (const source of sources.sort((a, b) => priority(a) - priority(b))) {
        const name = source.type === 'document' ? (this.documents.entries.get(source.id)?.name || 'Uploaded document') : source.name;
        descriptions.push({ type: source.type, kind: source.kind, name });
        usable.push({ source, row: { name } });
      }
      onStage('understanding');
      try { plan = validateResearchPlan(await model(buildResearchPrompt(request, descriptions))); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        return { ...empty, calls, state: 'assessment-failed', message: 'Task assessment failed or returned an invalid plan. Retry before generation.' };
      }
      if (!plan.assessment.actionable) return { ...empty, calls, assessment: plan.assessment, state: 'non-actionable', message: NO_TASK[request.language] };
      plan.questions = plan.questions.map((q, i) => ({ ...q, id: `r${i + 1}` }));
      plan.sources = descriptions;
      const limits = RESEARCH_LIMITS[plan.assessment.research];
      for (const item of usable) if (item.source.type === 'document') {
        try { item.row = this.documents.get(item.source.id); }
        catch { item.expired = true; warnings.push('A document expired. Add it again or continue without it.'); }
      }
      const lookup = async (qs, items, cap = limits.lookups) => {
        let added = 0;
        for (const { source, row, expired } of items) {
          combined.throwIfAborted();
          if (expired) continue;
          const topic = new Set(terms([request.input, ...plan.assessment.entities, ...evidence().map(item => item.text)].join(' ')));
          const queries = qs.filter(query => relevant(query, source, row) && terms(query.query).some(word => topic.has(word))).map(query => ({ ...query, questionId: query.id })).filter(query => {
            if (source.type === 'mcp' && !safeExternalQuery(query.query)) {
              if (!warnings.includes('An external lookup containing a private path, credential-like text, code, or contact detail was skipped.')) warnings.push('An external lookup containing a private path, credential-like text, code, or contact detail was skipped.');
              return false;
            }
            const key = JSON.stringify([source, query.libraryHint, query.query]);
            if (seen.has(key) || lookups >= cap) return false;
            seen.add(key); lookups++; return true;
          });
          if (!queries.length) { if (!outcomes.has(row.name)) outcomes.set(row.name, { name: row.name, status: 'not-needed' }); continue; }
          onStage(source.type === 'local' ? 'project' : 'retrieving');
          try {
            let found = [];
            if (source.type === 'local') {
              const result = await abortable(this.local.retrieve(source, queries, { signal: combined }), combined); found = result.evidence;
              if (result.truncated) warnings.push(`${row.name}: a bounded subset of files was inspected; the implementation agent must verify the complete project.`);
            } else if (source.type === 'mcp') {
              const cfg = source.preset ? { type: 'mcp', preset: source.preset } : source;
              const retrieved = await abortable(this.mcp.retrieve(cfg, queries, { signal: combined }), combined);
              if (retrieved.warning) warnings.push(`${row.name}: ${retrieved.warning}`);
              for (const item of retrieved) {
                for (const chunk of search(buildIndex(chunkPages([{ page: 1, text: item.text }])), item.query)) found.push({ sourceType: 'mcp', source: item.source, locator: item.locator, query: item.query, text: chunk.text, score: chunk.score, questionIds: [item.questionId] });
              }
            } else {
              const index = source.type === 'expert' ? buildIndex(chunkPages([{ page: 1, text: source.text }])) : row.index;
              for (const query of queries) for (const chunk of search(index, query.query)) found.push({ sourceType: source.type === 'expert' ? 'expert' : row.sourceType, source: row.name,
                locator: source.type === 'expert' ? 'manual context' : row.sourceType === 'pdf' ? `page ${chunk.page}` : `characters ${chunk.start + 1}–${chunk.end}`, query: query.query, text: chunk.text, score: chunk.score, questionIds: [query.questionId] });
            }
            // Prefer the actual local project and selected documents when facts overlap.
            candidates.push(...found.map(row => ({ ...row, score: row.score + (source.type === 'local' ? 2 : source.type === 'expert' ? 1 : source.type === 'document' ? 0.5 : 0) })));
            added += found.length;
            outcomes.set(row.name, { name: row.name, status: found.length ? 'retrieved' : 'no-relevant-context' });
          } catch (error) {
            if (combined.aborted) throw error;
            warnings.push(source.type === 'mcp' ? `${row.name}: ${error.message}` : `${row.name}: context unavailable. Continue with explicit inspection instructions.`);
            outcomes.set(row.name, { name: row.name, status: 'failed' });
          }
        }
        return added;
      };
      const checkpoint = async (canContinue, repositoryFirst = false) => {
        const current = evidence();
        if (!current.length) return null;
        onStage('research-review');
        try { return validateResearchReview(await model(buildResearchReviewPrompt(request, plan, current, { canContinue, repositoryFirst })), current, { canContinue }); }
        catch (error) { if (combined.aborted) throw error; warnings.push('Research synthesis was invalid. Only small exact retrieved excerpts will be used.'); return null; }
      };
      if (limits.lookups) {
        const local = usable.filter(item => item.source.type !== 'mcp'), remote = usable.filter(item => item.source.type === 'mcp');
        // Seed an actual project overview if the task needs it; never let the model choose filesystem paths.
        if (plan.assessment.needsProject && local.some(item => item.source.kind === 'repository')) {
          const seed = { id: 'r32', question: 'Which framework, dependencies and existing implementation does this repository use?', reason: 'Ground the change in the actual project.', sourceHint: 'repository', libraryHint: '', query: 'existing project framework dependencies architecture ' + request.input.slice(0, 250) };
          if (!plan.questions.some(q => q.sourceHint === 'repository')) plan.questions.unshift(seed);
          if (plan.questions.length > 24) plan.questions.pop();
          plan.questions = plan.questions.map((q, i) => ({ ...q, id: `r${i + 1}` }));
        }
        const firstCap = limits.rounds > 1 ? limits.lookups - 6 : limits.lookups;
        await lookup(plan.questions, local, remote.length ? Math.min(firstCap, Math.max(1, Math.floor(limits.lookups / 3))) : firstCap);
        let external = plan.questions;
        if (plan.assessment.needsProject && !evidence().some(row => row.sourceType === 'repository')) {
          external = [];
          plan.unverified.push('Inspect the actual project framework, dependencies, existing implementation and conventions before choosing compatible integration details.');
          warnings.push('Project context is unavailable. External research was deferred; the implementation agent must inspect the actual repository first.');
        }
        if (remote.length && plan.assessment.needsProject && evidence().some(row => row.sourceType === 'repository')) {
          const refined = await checkpoint(remote.length > 0 && lookups < limits.lookups, true);
          if (refined) {
            review = refined;
            // Only queries based on actual project evidence may contact external sources.
            plan.questions = plan.questions.filter(q => ['repository', 'local', 'knowledge', 'document', 'expert', 'all'].includes(q.sourceHint));
            external = refined.questions.slice(0, 32 - plan.questions.length).map((q, i) => ({ ...q, id: `r${plan.questions.length + i + 1}` }));
            plan.questions.push(...external);
          } else external = []; // A failed project checkpoint must not invent a greenfield stack.
        }
        await lookup(external, remote, firstCap); rounds = lookups ? 1 : 0;
        const canContinue = limits.rounds > 1 && lookups < limits.lookups && calls < 3;
        const next = await checkpoint(canContinue);
        if (next) review = next;
        if (next?.continueResearch && next.questions.length && canContinue) {
          // Newly discovered dependencies can justify one additional targeted pass.
          const newQs = next.questions.slice(0, 32 - plan.questions.length).map((q, i) => ({ ...q, id: `r${plan.questions.length + i + 1}` }));
          const before = lookups;
          const added = newQs.length ? await lookup(newQs, usable) : 0;
          if (lookups > before) { plan.questions.push(...newQs); rounds++; }
          if (added) review = await checkpoint(false) || review;
        }
      }
      const rows = evidence(), grounding = researchGrounding(plan, rows, review);
      if (!usable.length && plan.questions.length) warnings.push('No context sources are enabled. Unverified details become implementation-time inspection instructions.');
      for (const { row } of usable) if (!outcomes.has(row.name)) outcomes.set(row.name, { name: row.name, status: 'not-needed' });
      onStage('ready');
      return { state: 'ready', assessment: plan.assessment, grounding, evidence: grounding.evidence, warnings, sources: [...outcomes.values()], calls,
        research: { questions: plan.questions.length, lookups, rounds, reason: review?.reason || plan.assessment.reason } };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!plan) throw error;
      warnings.push('Research reached its time budget. Generate using available evidence and explicit unresolved inspection instructions.');
      const grounding = researchGrounding(plan, evidence(), review);
      return { state: 'ready', assessment: plan.assessment, grounding, evidence: grounding.evidence, warnings, sources: [...outcomes.values()], calls, research: { lookups, rounds, reason: 'Time budget reached.' } };
    } finally { clearTimeout(deadline); }
  }
}
