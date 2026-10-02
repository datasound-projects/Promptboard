// Deterministic local MCP fixture. No model calls and no network/credentials.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'okay';
if (mode === 'child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.argv[3], String(child.pid));
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (mode === 'hang') continue;
  if (mode === 'flood') { process.stdout.write('x'.repeat(1_100_000)); continue; }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'local-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'read_document', description: 'untrusted description', inputSchema: { type: 'object', properties: {} } }] };
  else if (request.method === 'resources/list') result = { resources: [{ name: 'Guide', uri: 'fixture://guide' }] };
  else if (request.method === 'prompts/list') result = { prompts: [{ name: 'summarize' }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Not supported' } }) + '\n'); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
