/** Every test server owns a disposable data directory, including background Autopilot reads. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../src/server.mjs';

export async function startTestServer(t, { initialState, ...options } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pb-server-fixture-'));
  let app;
  try {
    if (initialState !== undefined) await writeFile(join(dataDir, 'state.json'), JSON.stringify(initialState));
    // Metadata lookup is inert unless this particular test explicitly supplies a fixture.
    // No Network job worker unless a test passes one, so no real CLI can ever be started from a test.
    app = await startServer({ catalogReader: async provider => ({ provider, source: 'test fixture', models: [] }), networkWorker: null, ...options, dataDir });
  }
  catch (error) { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw error; }
  t.after(async () => {
    try { await app.close(); }
    finally { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  return app;
}
