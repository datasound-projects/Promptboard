import { normalizePipelineConfig } from '../../src/pipeline-config.mjs';

/**
 * The seven-column pipeline as it was before column types: every active column is `custom` (one conversation that
 * continues across compatible columns), and Planning is a native plan-mode column whose approval routes to
 * Executing. Tests of custom-column behaviour use this; new boards default to typed stage columns.
 */
export function customPipelineConfig() {
  const seeds = [['todo', 'To Do', 'gray', 'todo'], ['planning', 'Planning', 'violet'], ['executing', 'Executing', 'blue'],
    ['code_review', 'Code Review', 'amber'], ['testing', 'Testing', 'teal'], ['merge', 'Merge', 'pink'], ['done', 'Done', 'green', 'done']];
  return normalizePipelineConfig({ version: 1, columns: seeds.map(([id, name, color, role]) => ({ id, name, color, ...(role ? { role } : { kind: 'custom' }),
    strategy: id === 'planning' ? { permissionMode: 'plan', planExitTargetId: 'executing' } : {}, automations: {} })) });
}
