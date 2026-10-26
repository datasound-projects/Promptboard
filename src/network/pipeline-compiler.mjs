/**
 * Pipeline compiler (docs/network/architecture.md §9, §14 item 13, §20): one pipeline definition — a published version,
 * or a draft for "validate" — becomes a plan the runner executes without reading any draft again. The plan pins the exact
 * pipeline and network versions (with their hashes), expands each sub-pipeline step into the steps of the published
 * pipeline it names (step IDs namespaced `<substep>/<step>`, at most 4 deep, at most 2,000 steps), checks every agent step
 * against the registration (registered, a member of the step's pinned network version, switched on, not stale, its
 * provider able to use the step's tools), and types what flows along the execution edges.
 *
 * Scope: a pipeline belongs to one network version; a sub-pipeline must belong to a network that this network version
 * contains, at exactly the version it pins. So no step can reach an agent outside the networks the owner composed, and no
 * step reaches a project (pipeline jobs carry none). Graph relations are never read: only execution edges carry data.
 *
 * Conditions are a fixed interpreter over typed JSON values (`decide`): no eval, no Function, no model-written code.
 * `load` = { pipeline(id, version) → published version with sha256, network(id, version) → network version with sha256,
 * agent(id) → the registration view (registry.agent) }; each throws NetworkError when it cannot answer.
 */
import { fail, object } from './storage.mjs';

export const PLAN_LIMITS = Object.freeze({ steps: 2000, depth: 4, evidence: 200 });
const LIMITS = PLAN_LIMITS;
/** A rule's path in a definition: `<stepId>.json` and up to 8 fields (object keys or array indexes). */
export const RULE_PATH = /^(n_[0-9a-f]{12})\.json((?:\.[A-Za-z0-9_-]{1,64}){0,8})$/;

/**
 * Topological order of `ids` along `links` ([from, to]) in the order steps become free (Kahn), or the loop that prevents
 * one (`cycle`, first step repeated at the end), found by walking back from a step left over.
 */
export function order(ids, links) {
  const count = new Map(ids.map(id => [id, 0])), next = new Map(ids.map(id => [id, []])), back = new Map(ids.map(id => [id, []]));
  for (const [from, to] of links) { count.set(to, count.get(to) + 1); next.get(from).push(to); back.get(to).push(from); }
  const queue = ids.filter(id => !count.get(id));
  for (const id of queue) for (const to of next.get(id)) { count.set(to, count.get(to) - 1); if (!count.get(to)) queue.push(to); }
  if (queue.length === ids.length) return { order: queue, cycle: null };
  const left = new Set(ids.filter(id => count.get(id) > 0)), seen = new Map(), path = [];
  let at = [...left][0];
  while (!seen.has(at)) { seen.set(at, path.length); path.push(at); at = back.get(at).find(id => left.has(id)); }
  return { order: null, cycle: [...path.slice(seen.get(at)), at].reverse() };
}

const TESTS = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b, in: (a, b) => b.includes(a), exists: () => true,
  lt: (a, b) => typeof a === 'number' && a < b, lte: (a, b) => typeof a === 'number' && a <= b,
  gt: (a, b) => typeof a === 'number' && a > b, gte: (a, b) => typeof a === 'number' && a >= b,
  contains: (a, b) => (typeof a === 'string' ? typeof b === 'string' && a.includes(b) : Array.isArray(a) && a.includes(b)),
};
/** A JSON value by its fields: own keys of objects and indexes of arrays only; anything else is missing (undefined). */
function at(value, fields) {
  for (const field of fields) {
    if (Array.isArray(value) && /^\d+$/.test(field)) value = value[Number(field)];
    else if (object(value) && Object.hasOwn(value, field)) value = value[field];
    else return undefined;
  }
  return value;
}
/**
 * A condition's decision from the json results it reads (`json(stepId)` → the parsed result.json or undefined): each rule
 * with the value it found (as bounded JSON text) and whether it matched. A missing value matches no operator (use exists).
 */
export function decide(config, json) {
  const mode = config.all ? 'all' : 'any';
  const rules = config[mode].map(rule => {
    const actual = at(json(rule.node), rule.fields), matched = actual !== undefined && TESTS[rule.op](actual, rule.value);
    const shown = actual === undefined ? null : JSON.stringify(actual);
    return { path: rule.path, op: rule.op, ...(rule.op === 'exists' ? {} : { value: rule.value }), actual: shown && shown.length > LIMITS.evidence ? `${shown.slice(0, LIMITS.evidence - 1)}…` : shown, missing: actual === undefined, matched };
  });
  return { mode, result: mode === 'all' ? rules.every(rule => rule.matched) : rules.some(rule => rule.matched), rules };
}

/**
 * The plan of `root` ({ pipelineId, version (null for a draft), sha256, name, networkId, networkVersion, settings, nodes,
 * edges }): `{ pipeline, network, settings, pins, groups, nodes }`, nodes in topological order, each with `deps` (the
 * execution edges into it, after expansion) and `inputs` (the artifacts that can reach it: an agent's text or json, a
 * sub-pipeline's output text; the other steps pass on what reaches them).
 */
export async function compilePipeline(root, load) {
  const steps = new Map(), groups = [], pins = { pipelines: [], networks: [] }, agents = new Map();
  const network = async (id, version) => {
    const pinned = await load.network(id, version);
    if (!pins.networks.some(pin => pin.networkId === id && pin.version === version)) pins.networks.push({ networkId: id, version, sha256: pinned.sha256 });
    return pinned;
  };
  const agent = async id => {
    if (!agents.has(id)) agents.set(id, await load.agent(id).catch(error => { if (error.code === 'NOT_FOUND') return null; throw error; }));
    return agents.get(id);
  };

  /** Adds `def`'s steps under `prefix`; answers where edges into it arrive (`entries`) and, for a sub-pipeline, its output step (`exit`). */
  async function expand(def, net, prefix, group, stack, depth) {
    const ends = new Map(); // a step of `def` → { entries, exit } as plan IDs (a sub-pipeline step → its own steps)
    for (const node of def.nodes) {
      const id = prefix + node.id, where = { nodeId: id };
      if (node.type === 'subnetwork') {
        const { pipelineId, version } = node.config;
        if (stack.includes(pipelineId)) fail('A pipeline cannot contain itself. Remove this sub-pipeline step.', 'PIPELINE_RECURSIVE', 400, { ...where, path: [...stack, pipelineId] });
        if (depth >= LIMITS.depth) fail(`Sub-pipelines nest at most ${LIMITS.depth} deep. Flatten this one.`, 'PIPELINE_DEPTH', 400, where);
        const child = await load.pipeline(pipelineId, version);
        // Scope: the child's network must be a sub-network of this network version, pinned at the same version.
        if (!net.nodes.some(item => item.type === 'subnetwork' && item.networkId === child.networkId && item.version === child.networkVersion)) {
          fail(`The sub-pipeline “${child.name}” belongs to a network version that this pipeline’s network does not contain. Add that network version to the network (Graph), publish it, and pin the new version.`, 'PIPELINE_SCOPE', 400, { ...where, pipelineId, networkId: child.networkId, networkVersion: child.networkVersion });
        }
        const childNet = await network(child.networkId, child.networkVersion);
        if (!pins.pipelines.some(pin => pin.pipelineId === pipelineId && pin.version === version)) pins.pipelines.push({ pipelineId, version, sha256: child.sha256 });
        groups.push({ id, parent: group, label: node.label || child.name, pipelineId, version, sha256: child.sha256, networkId: child.networkId, networkVersion: child.networkVersion });
        ends.set(node.id, await expand({ ...child, pipelineId }, childNet, `${id}/`, id, [...stack, pipelineId], depth + 1));
        continue;
      }
      let label = node.label;
      if (node.type === 'agent') {
        const { agentId, tools } = node.config, view = await agent(agentId), who = { ...where, agentId };
        if (!view) fail('An agent step names an agent that is not registered in Network.', 'AGENT_NOT_FOUND', 400, who);
        const name = view.displayName || view.base.name || agentId;
        if (!net.nodes.some(item => item.type === 'agent' && item.agentId === agentId)) fail(`“${name}” is not a member of the network version this pipeline step belongs to. Add it in Graph and publish, or choose a member.`, 'PIPELINE_AGENT_NOT_IN_NETWORK', 400, who);
        if (!view.enabled) fail(`“${name}” is switched off in Network. Switch it on, or choose another agent.`, 'REGISTRATION_DISABLED', 409, who);
        if (view.base.stale) fail(`“${name}”’s Base definition cannot be used (${view.base.staleReason}). Fix it in Base first.`, 'REGISTRATION_STALE', 409, { ...who, staleReason: view.base.staleReason });
        if (!view.providerCapabilities.jobTools?.includes(tools)) fail(`“${name}”’s provider cannot run this step with ${tools} tools.`, view.providerCapabilities.jobTools?.length ? 'TOOLS_UNSUPPORTED' : 'PROVIDER_UNSUPPORTED', 409, who);
        label ||= name;
      }
      steps.set(id, { id, type: node.type, label, group, networkId: def.networkId, config: node.config, deps: [] });
      if (steps.size > LIMITS.steps) fail(`A pipeline expands to at most ${LIMITS.steps} steps with its sub-pipelines.`, 'PIPELINE_TOO_LARGE', 400, { steps: LIMITS.steps });
      ends.set(node.id, { entries: [id], exit: id });
    }
    for (const edge of def.edges) for (const to of ends.get(edge.to).entries) steps.get(to).deps.push({ from: ends.get(edge.from).exit, port: edge.fromPort });
    // Rule paths and output includes name steps of `def`: plan IDs now (a sub-pipeline step stands for its output step).
    for (const node of def.nodes) {
      const step = steps.get(prefix + node.id);
      if (node.type === 'condition') {
        const mode = node.config.all ? 'all' : 'any';
        step.config = { [mode]: node.config[mode].map(rule => { const [, local, fields] = RULE_PATH.exec(rule.path); return { ...rule, node: ends.get(local).exit, fields: fields ? fields.slice(1).split('.') : [] }; }) };
      }
      if (node.type === 'output') {
        step.config = { ...node.config, include: node.config.include.map(local => ends.get(local).exit) };
        step.file = `${group ? `${group.replaceAll('/', '.')}.` : ''}${node.config.name}.md`;
      }
    }
    const outputs = def.nodes.filter(node => node.type === 'output'), arriving = new Set(def.edges.map(edge => edge.to));
    if (!outputs.length) fail('A pipeline ends in at least one output step that saves its report.', 'PIPELINE_NO_OUTPUT', 400, group ? { nodeId: group } : {});
    if (group && outputs.length !== 1) fail('A sub-pipeline has exactly one output step: it is what the sub-pipeline step passes on.', 'SUBPIPELINE_OUTPUT', 400, { nodeId: group });
    return { entries: def.nodes.filter(node => !arriving.has(node.id)).flatMap(node => ends.get(node.id).entries), exit: group ? prefix + outputs[0].id : null };
  }

  const rootNet = await network(root.networkId, root.networkVersion);
  await expand(root, rootNet, '', null, [root.pipelineId], 0);
  const ids = [...steps.keys()], sorted = order(ids, [...steps.values()].flatMap(step => step.deps.map(dep => [dep.from, step.id])));
  if (sorted.cycle) fail('The execution edges form a loop. Pipelines run each step once: remove an edge of the loop.', 'PIPELINE_CYCLE', 400, { path: sorted.cycle });
  // Typed artifacts, in order: what can reach each step, and that conditions and outputs read only what reaches them.
  const names = new Set();
  for (const id of sorted.order) {
    const step = steps.get(id), seen = new Set(), inputs = [];
    for (const dep of step.deps) {
      const from = steps.get(dep.from);
      for (const ref of from.type === 'agent' ? [{ node: dep.from, port: dep.port }] : from.type === 'output' ? [{ node: dep.from, port: 'text' }] : from.inputs) {
        const key = `${ref.node}>${ref.port}`;
        if (!seen.has(key)) { seen.add(key); inputs.push(ref); }
      }
    }
    step.inputs = inputs;
    if (step.type === 'condition') {
      for (const rule of step.config.all || step.config.any) if (!seen.has(`${rule.node}>json`)) fail(`The condition reads ${rule.path}, but no json result of that step reaches it. Connect that agent step’s json port on the way to the condition.`, 'CONDITION_PORT', 400, { nodeId: id, path: rule.path });
    }
    if (step.type === 'output') {
      for (const node of step.config.include) if (!inputs.some(ref => ref.node === node)) fail('The output step includes a step whose result does not reach it. Connect that step on the way to the output, or remove it from the list.', 'OUTPUT_INCLUDE_MISSING', 400, { nodeId: id, include: node });
      if (!step.group && names.has(step.config.name)) fail(`Two output steps save “${step.config.name}”. Give each output its own name.`, 'OUTPUT_NAME_TAKEN', 400, { nodeId: id });
      if (!step.group) names.add(step.config.name);
    }
  }
  return { pipeline: { id: root.pipelineId, version: root.version, sha256: root.sha256, name: root.name }, network: { id: root.networkId, version: root.networkVersion, sha256: rootNet.sha256 },
    settings: root.settings, pins, groups, nodes: sorted.order.map(id => steps.get(id)) };
}
