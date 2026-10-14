import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board.mjs';

async function board(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-base-fixes-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  return new Board({ dataDir });
}
const revision = async b => (await b.state()).base.revision;

test('an agent profile is a target\'s profile, never one of a project\'s resources; profiles still nest in profiles', async t => {
  const b = await board(t), project = await b.createProject({ name: 'P' });
  const lead = await b.base.create({ kind: 'profile', name: 'Lead', configuration: { agent: { provider: 'codex' }, binding: { mode: 'inherit', include: [], exclude: [] } } });
  const include = id => ({ mode: 'extend', include: [{ resourceId: id, required: true }], exclude: [] });
  // A profile's own binding may equip another profile (a nested agent).
  await b.base.create({ kind: 'profile', name: 'Team', configuration: { agent: {}, binding: include(lead.id) } });
  await assert.rejects(b.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, binding: include(lead.id) }], expectedBaseRevision: await revision(b) }), /as the agent profile of a global, project or column target/);
  await b.base.apply({ changes: [{ target: { scope: 'project', projectId: project.id }, binding: { mode: 'inherit', include: [], exclude: [] }, profileId: lead.id }], expectedBaseRevision: await revision(b) });
  assert.equal((await b.state()).projects[0].agentProfileId, lead.id);
});

test('importing SKILL.md again replaces the earlier copy instead of failing on a duplicate path', async t => {
  const b = await board(t);
  const markdown = '---\nname: Review\ndescription: Checks\n---\nCheck the invariants.\n';
  const skill = await b.base.importSkill({ markdown, files: [{ path: 'SKILL.md', text: 'old copy' }, { path: 'notes.md', text: 'notes' }] });
  const { content } = await b.base.readRevision(skill.revisionRef);
  assert.deepEqual(content.files.map(file => [file.path, file.text]), [['SKILL.md', markdown], ['notes.md', 'notes']]);
});
