import { validateRequest } from './engine.mjs';
import { makeTempDir, removeTempDir, validateEffort, ProviderError } from './providers.mjs';
import { invalid, object, list, string } from './compose-grounding.mjs';
import { NO_TASK, obviouslyNonActionable } from './compose-intent.mjs';
import { ComposeDocuments } from './compose-documents.mjs';
import { ComposeMcp, validateMcp } from './compose-mcp.mjs';
import { ComposeLocal, validateLocal } from './compose-local.mjs';
import { buildIndex, chunkPages, search, budgetEvidence, terms } from './compose-retrieval.mjs';
import { RESEARCH_LIMITS, safeExternalQuery, validateResearchPlan, buildResearchPrompt, buildResearchReviewPrompt, validateResearchReview, researchGrounding } from './compose-research.mjs';
import { abortable } from './cancellation.mjs';

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
const priority = source => source.type === 'local' && source.purpose === 'target' ? 0 : source.type === 'local' ? 1 : source.type === 'expert' ? 2 : source.type === 'document' ? 3 : source.preset === 'context7' ? 4 : 5;
const relevant = (query, source, row, id) => ['all', id, source.type, source.kind, source.preset, row.name.toLowerCase()].includes(query.sourceHint.toLowerCase());
const allocate = (questions, additions) => {
  const ids = new Set(questions.map(q => q.id));
  return additions.slice(0, 32 - ids.size).map(q => { const id = Array.from({ length: 32 }, (_, i) => `r${i + 1}`).find(id => !ids.has(id)); ids.add(id); return { ...q, id }; });
};

export class ComposeContext {
  constructor({ documents = new ComposeDocuments(), mcp = new ComposeMcp(), local = new ComposeLocal() } = {}) { this.documents = documents; this.mcp = mcp; this.local = local; }
  close() { this.documents.close(); this.mcp.close?.(); this.local.close(); }
  async prepare(body, { runner, signal, onStage = () => {}, timeoutMs = null } = {}) {
    const { request, autonomous, sources } = validatePreparation(body);
    const empty = { evidence: [], warnings: [], sources: [], calls: 0, research: { lookups: 0, rounds: 0 } };
    if (obviouslyNonActionable(request.input)) return { ...empty, state: 'non-actionable', message: NO_TASK[request.language] };
    if (!autonomous) return { ...empty, state: 'ready', grounding: {} };
    validateEffort(request.provider, request.effort);
    const controller = new AbortController(), deadline = timeoutMs === null ? undefined : setTimeout(() => controller.abort(new DOMException('Research time budget expired.', 'TimeoutError')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const started = Date.now(), warnings = [], usable = [], descriptions = [], outcomes = new Map(), origins = new Map(), seen = new Set(), localReads = new Set(), candidates = [];
    let calls = 0, lookups = 0, rounds = 0, plan, review;
    const model = async prompt => {
      combined.throwIfAborted();
      if (calls >= 4) throw new Error('Planning call budget reached.');
      const cwd = await makeTempDir('ste-compose-research-');
      const duration = timeoutMs === null ? null : Math.min(90_000, Math.max(1, timeoutMs - (Date.now() - started)));
      const modelSignal = duration === null ? combined : AbortSignal.any([combined, AbortSignal.timeout(duration)]);
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
      // Only bounded previews of already supplied text: no traversal/parsing/network before assessment.
      for (const [i, source] of sources.entries()) {
        const name = source.type === 'document' ? (this.documents.entries.get(source.id)?.name || 'Uploaded document') : source.name;
        const id = `s${i + 1}`, cached = source.type === 'document' ? this.documents.entries.get(source.id) : undefined;
        const preview = source.type === 'expert' ? source.text.slice(0, 1200) : cached?.index.rows[0]?.text.slice(0, 1200);
        descriptions.push({ id, type: source.type, kind: source.kind, purpose: source.purpose, name, ...(preview ? { preview } : {}) });
        usable.push({ id, source, row: { name } });
      }
      usable.sort((a, b) => priority(a.source) - priority(b.source));
      onStage('understanding');
      try { plan = validateResearchPlan(await model(buildResearchPrompt(request, descriptions))); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ProviderError) throw error;
        return { ...empty, calls, state: 'ready', grounding: {}, warnings: ['Task assessment was unavailable or invalid. Continue with the original task; no research facts or objective were invented.'] };
      }
      if (!plan.assessment.actionable) return { ...empty, calls, assessment: plan.assessment, state: 'non-actionable', message: NO_TASK[request.language] };
      plan.sources = descriptions;
      const limits = RESEARCH_LIMITS[plan.assessment.research];
      const lookup = async (qs, items, cap = limits.lookups) => {
        let added = 0;
        for (const item of items) {
          const { id, source } = item; let { row } = item;
          combined.throwIfAborted();
          if (plan.assessment.research === 'none' && source.type === 'mcp') continue;
          const topic = new Set(terms([request.input, ...plan.assessment.entities, ...evidence().map(item => item.text)].join(' ')));
          const grouped = new Map();
          for (const query of qs.filter(query => query.kind !== 'choice' && relevant(query, source, row, id)
            && (source.type !== 'mcp' || query.sourceHint.toLowerCase() === id || terms(query.query).some(word => topic.has(word)))).map(query => ({ ...query, questionId: query.id,
              allowPreview: [id, row.name.toLowerCase()].includes(query.sourceHint.toLowerCase()) }))) {
            if (source.type === 'mcp' && !safeExternalQuery(query.query)) {
              if (!warnings.includes('An external lookup containing a private path, credential-like text, code, or contact detail was skipped.')) warnings.push('An external lookup containing a private path, credential-like text, code, or contact detail was skipped.');
              continue;
            }
            const key = JSON.stringify([id, query.libraryHint.normalize('NFKC').toLowerCase().trim(), terms(query.query).join(' ')]);
            const existing = grouped.get(key);
            if (existing) { existing.questionIds.push(query.questionId); existing.allowPreview ||= query.allowPreview; continue; }
            if (seen.has(key) || lookups >= cap) continue;
            seen.add(key); lookups++; grouped.set(key, { ...query, questionIds: [query.questionId] });
          }
          const queries = [...grouped.values()];
          if (!queries.length) { if (!outcomes.has(id)) outcomes.set(id, { id, name: row.name, status: 'not-needed' }); continue; }
          onStage(source.type === 'local' ? 'project' : 'retrieving');
          try {
            let found = [];
            if (source.type === 'local') {
              const result = await abortable(this.local.retrieve(source, queries, { signal: combined, refresh: !localReads.has(source.path) }), combined); localReads.add(source.path); found = result.evidence;
              if (result.truncated) warnings.push(`${row.name}: a bounded subset of files was inspected; the implementation agent must verify the complete project.`);
            } else if (source.type === 'mcp') {
              const cfg = source.preset ? { type: 'mcp', preset: source.preset } : source;
              const retrieved = await abortable(this.mcp.retrieve(cfg, queries, { signal: combined }), combined);
              if (retrieved.warning) warnings.push(`${row.name}: ${retrieved.warning}`);
              for (const item of retrieved) {
                for (const chunk of search(buildIndex(chunkPages([{ page: 1, text: item.text }])), item.query)) found.push({ sourceType: 'mcp', source: item.source, locator: item.locator, query: item.query, text: chunk.text, score: chunk.score, questionIds: queries.find(q => q.questionId === item.questionId)?.questionIds || [item.questionId] });
              }
            } else {
              if (source.type === 'document') { row = this.documents.get(source.id); item.row = row; }
              const index = source.type === 'expert' ? buildIndex(chunkPages([{ page: 1, text: source.text }])) : row.index;
              for (const query of queries) {
                const hits = search(index, query.query), preview = !hits.length && query.allowPreview;
                for (const chunk of preview ? index.rows.slice(0, 1) : hits) found.push({ sourceType: source.type === 'expert' ? 'expert' : row.sourceType, source: row.name,
                  locator: source.type === 'expert' ? 'manual context' : row.sourceType === 'pdf' ? `page ${chunk.page}` : `${chunk.section ? `${chunk.section} · ` : ''}characters ${chunk.start + 1}–${chunk.end}`, query: query.query,
                  text: preview ? chunk.text.slice(0, 1200) : chunk.text, score: preview ? 0 : chunk.score, questionIds: query.questionIds, ...(preview ? { provisional: true } : {}) });
              }
            }
            // Prefer the actual local project and selected documents when facts overlap.
            candidates.push(...found.map(row => ({ ...row, score: row.score + (source.purpose === 'target' ? 2 : source.type === 'expert' ? 1 : source.type === 'document' ? 0.5 : 0) })));
            const keys = origins.get(id) || new Set(); for (const item of found) keys.add(JSON.stringify([item.sourceType, item.source, item.locator])); origins.set(id, keys);
            added += found.length;
            outcomes.set(id, { id, name: row.name, status: found.length ? 'retrieved' : 'no-relevant-context' });
          } catch (error) {
            if (combined.aborted) throw error;
            warnings.push(source.type === 'mcp' ? `${row.name}: ${error.message}` : `${row.name}: context unavailable. Continue with explicit inspection instructions.`);
            outcomes.set(id, { id, name: row.name, status: 'failed' });
          }
        }
        return added;
      };
      const checkpoint = async (canContinue, repositoryFirst = false) => {
        const current = evidence();
        if (!current.length) return null;
        onStage('research-review');
        try { return validateResearchReview(await model(buildResearchReviewPrompt(request, plan, current, { canContinue, repositoryFirst })), current, { canContinue, questions: plan.questions }); }
        catch (error) { if (combined.aborted || error instanceof ProviderError) throw error; warnings.push('Research synthesis was invalid. Only small exact retrieved excerpts will be used; questions remain unresolved.'); return null; }
      };
      if (limits.lookups) {
        const local = usable.filter(item => item.source.type !== 'mcp'), remote = plan.assessment.research === 'none' ? [] : usable.filter(item => item.source.type === 'mcp');
        // Seed an actual project overview if the task needs it; never let the model choose filesystem paths.
        if (plan.assessment.needsProject && local.some(item => item.source.kind === 'repository' && item.source.purpose === 'target')) {
          const seed = { id: 'r32', question: 'Which framework, dependencies and existing implementation does this repository use?', reason: 'Ground the change in the actual project.', sourceHint: 'repository', libraryHint: '', query: 'existing project framework dependencies architecture ' + request.input.slice(0, 250) };
          if (!plan.questions.some(q => q.sourceHint === 'repository') && plan.questions.length < limits.questions) plan.questions.unshift(...allocate(plan.questions, [seed]));
        }
        const firstCap = limits.rounds > 1 ? limits.lookups - 6 : limits.lookups;
        await lookup(plan.questions, local, remote.length ? Math.min(firstCap, Math.max(1, Math.floor(limits.lookups / 3))) : firstCap);
        let external = plan.questions;
        const hasTarget = () => evidence().some(row => [row, ...(row.alsoFrom || [])].some(origin => origin.sourceType === 'repository' && origin.purpose === 'target'));
        if (plan.assessment.needsProject && !hasTarget()) {
          external = [];
          plan.unverified.push('Inspect the actual project framework, dependencies, existing implementation and conventions before choosing compatible integration details.');
          warnings.push('Project context is unavailable. External research was deferred; the implementation agent must inspect the actual repository first.');
        }
        if (remote.length && plan.assessment.needsProject && hasTarget()) {
          const refined = await checkpoint(remote.length > 0 && lookups < limits.lookups, true);
          if (refined) {
            review = refined;
            // Only queries based on actual project evidence may contact external sources.
            external = allocate(plan.questions, refined.questions);
            plan.questions.push(...external);
          } else external = []; // A failed project checkpoint must not invent a greenfield stack.
        }
        await lookup(external, remote, firstCap); rounds = lookups ? 1 : 0;
        const canContinue = limits.rounds > 1 && lookups < limits.lookups && calls < 3;
        const next = await checkpoint(canContinue);
        if (next) review = next;
        if (next?.continueResearch && next.questions.length && canContinue) {
          // Newly discovered dependencies can justify one additional targeted pass.
          const newQs = allocate(plan.questions, next.questions);
          const before = lookups;
          const added = newQs.length ? await lookup(newQs, usable) : 0;
          if (lookups > before) { plan.questions.push(...newQs); rounds++; }
          if (added) review = await checkpoint(false) || review;
        }
      }
      const rows = evidence(), grounding = researchGrounding(plan, rows, review);
      if (!usable.length && plan.questions.length) warnings.push('No context sources are enabled. Unverified details become implementation-time inspection instructions.');
      for (const { id, row } of usable) {
        if (!outcomes.has(id)) outcomes.set(id, { id, name: row.name, status: 'not-needed' });
        else if (outcomes.get(id).status === 'retrieved' && !grounding.evidence.some(e => [e, ...(e.alsoFrom || [])].some(origin => origins.get(id)?.has(JSON.stringify([origin.sourceType, origin.source, origin.locator]))))) outcomes.get(id).status = 'no-relevant-context';
      }
      if (grounding.unresolvedQuestions.length) warnings.push('Some material details remain unverified. The prompt will retain appropriate inspection or assumption instructions.');
      onStage('ready');
      return { state: 'ready', assessment: plan.assessment, grounding, evidence: grounding.evidence, warnings, sources: [...outcomes.values()], calls,
        research: { questions: plan.questions.length, lookups, rounds, reason: review?.reason || plan.assessment.reason } };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProviderError) throw error;
      if (!plan) throw error;
      const expired = timeoutMs !== null && controller.signal.aborted;
      warnings.push(expired ? 'Research reached its requested time budget. Generate using available evidence and explicit unresolved inspection instructions.' : 'Research could not finish. Generate using available evidence and explicit unresolved inspection instructions.');
      const grounding = researchGrounding(plan, evidence(), review);
      return { state: 'ready', assessment: plan.assessment, grounding, evidence: grounding.evidence, warnings, sources: [...outcomes.values()], calls, research: { lookups, rounds, reason: expired ? 'Requested time budget reached.' : 'Research incomplete.' } };
    } finally { clearTimeout(deadline); }
  }
}
