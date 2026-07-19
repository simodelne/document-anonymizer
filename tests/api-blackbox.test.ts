import { describe, expect, it } from 'vitest';
import {
  appTransport,
  createPgasClient,
  fetchTransport,
  normalizeSessionDomain,
} from '@simodelne/pgas-server/client.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

function stubHandles() {
  const complete = async (): Promise<string> => JSON.stringify({ actions: [] });
  return {
    authorHandle: { modelId: 'stub-author', complete },
    observerHandle: { modelId: 'stub-observer', complete },
  };
}

describe('document-anonymizer API black-box contract', () => {
  it('creates and reads a session through the in-process external API transport', async () => {
    const server = await createPgasServer({
      programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
      drivers: stubHandles(),
      devMode: true,
    });

    const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
    const httpClient = createPgasClient(fetchTransport({ baseUrl: 'http://127.0.0.1:0', token: 'dev-token' }));

    const programs = await client.programs.list();
    const session = await client.sessions.create({
      program: 'document-anonymizer',
      domain_context: { query: 'static black-box verification' },
    });
    const envelope = await client.sessions.get(session.sessionId);
    const world = await client.sessions.world(session.sessionId);
    const normalized = normalizeSessionDomain(world.domain);

    expect(programs).toBeDefined();
    expect(envelope.sessionId).toBe(session.sessionId);
    expect(normalized).toBeDefined();
    expect(httpClient).toBeDefined();
  });
});
