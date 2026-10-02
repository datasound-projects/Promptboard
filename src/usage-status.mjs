#!/usr/bin/env node
// Claude's per-run status line: persist only documented numeric usage fields.
import { writeFileSync, renameSync, readSync } from 'node:fs';
import { limitWindows } from './usage-dashboard.mjs';
try {
  const buffer = Buffer.alloc(65537);
  let size = 0, n;
  while (size < buffer.length && (n = readSync(0, buffer, size, buffer.length - size, null)) > 0) size += n;
  if (size > 65536) process.exit(0);
  const value = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  const target = process.argv[2];
  const sessionId = typeof value.session_id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value.session_id) ? value.session_id : '';
  const cost = value.cost?.total_cost_usd;
  const snapshot = { at: Date.now(), sessionId, windows: limitWindows(value.rate_limits), costUSD: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null };
  if (target && sessionId) {
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 }); renameSync(temp, target);
  }
  if (snapshot.windows.length) process.stdout.write(snapshot.windows.map(w => `${w.label}: ${Math.round(w.remainingPercent)}% left`).join(' · '));
} catch {}
