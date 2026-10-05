/** Project-shared display metadata, never instructions or execution configuration. */
const fail = () => { const error = new Error('Use unique labels with a name, a hex color and a stable ID.'); error.code = 'INVALID_TASK_LABELS'; error.status = 400; throw error; };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

export function taskLabels(value = []) {
  if (!Array.isArray(value) || value.length > 100) fail();
  const ids = new Set(), names = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'name', 'color'].includes(key))
      || !id(row.id) || typeof row.name !== 'string' || !row.name.isWellFormed() || !row.name.trim() || row.name.trim().length > 60
      || /[\x00-\x1f\x7f-\x9f]/.test(row.name) || typeof row.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(row.color)) fail();
    const name = row.name.trim(), identity = name.normalize('NFC').toLowerCase();
    if (ids.has(row.id) || names.has(identity)) fail();
    ids.add(row.id); names.add(identity);
    return { id: row.id, name, color: row.color.toLowerCase() };
  });
}

export function taskLabelIds(value = [], labels = null) {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => !id(item)) || new Set(value).size !== value.length) fail();
  if (labels !== null && value.some(item => !labels.some(row => row.id === item))) fail();
  return [...value];
}

export function labelRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
