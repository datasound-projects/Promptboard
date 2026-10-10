import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A crashed owner's lease outlives it by one TTL. Rewrite the move's latest revision as if that time had passed; `change` may adjust it further. */
export async function expireLease(dataDir, key, change = () => {}) {
  const folder = join(dataDir, 'automations', createHash('sha256').update(JSON.stringify([key.projectId, key.taskId, key.transitionId])).digest('hex'));
  const path = join(folder, (await readdir(folder)).filter(name => /^\d{8}\.json$/.test(name)).sort().at(-1));
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.leaseExpiresAt = Date.now() - 1; change(data);
  await writeFile(path, JSON.stringify(data));
}
