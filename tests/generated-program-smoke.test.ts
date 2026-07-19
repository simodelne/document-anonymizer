import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient, type PgasClient } from '@simodelne/pgas-server/client.js';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

describe('generated document upload smoke', () => {
  it('runs synthesized document upload hermetically through the route for Document Anonymizer', async () => {
    const sentinel = `PGAS-UPLOAD-SENTINEL-${randomUUID()}`;
    const content = [
      'Generated route-level upload smoke fixture.',
      sentinel,
      'ASCII payload keeps byte length equal to character count for exact assertions.',
    ].join('\n');
    const result = await runUploadScenario([
      scripted(effect('begin_work', {})),
      scripted(effect('request_documents', {})),
      scripted(effect('ingest_documents', {}, 'stage_output')),
      scripted(effect('advance_ingest_to_detect_pii', { __stage_runtime: { now_iso: '2026-07-16T00:00:00.000Z', random: 0.25 } }, 'stage_output')),
    ], async ({ client, sessionId }) => {
      const upload = await uploadText(client, sessionId, 'source.txt', content);
      const [fileRef] = refsFromUpload(upload);
      expect(fileRef).toBeDefined();
      await client.sessions.trigger(sessionId, {
        channel: 'document_upload',
        payload: { ['inputs.document_intake.file_refs']: [{ fileId: fileRef.fileId, name: fileRef.name }] },
      });
      return { fileRef, content, sentinel };
    });

    expect(result.upload?.fileRef.fileId).toEqual(expect.any(String));
    expect(documentRefLanded(result.afterUpload.domain, String(result.upload?.fileRef.fileId))).toBe(true);
    const source = resultAt(result.final.domain, 'inputs.source_document');
    expect(source.status).toBe('extracted');
    expect(source.full_text).toBe(result.upload?.content);
    expect(String(source.full_text)).toContain(result.upload?.sentinel);
    expect(source.char_count).toBe(result.upload?.content.length);
    expect(source.file_count).toBe(1);
    expect(result.final.domain['inputs.source_document_ready']).toBe(true);
    // This hermetic upload smoke drives the upload + extraction route with a
    // scripted author; it cannot drive the downstream LLM stages (detect_pii →
    // anonymize → export → finalize → complete), so it asserts the program
    // branched into the anonymize pipeline after extraction. Full end-to-end
    // completion is covered by the live-drive harnesses (see audit/).
    expect(result.final.mode).toBe('detect_pii');
  });
});

interface Snapshot {
  mode: string | null;
  domain: Record<string, unknown>;
  awaiting?: Record<string, unknown>;
}

interface ScriptedAuthorResponse {
  response: ReturnType<typeof effect>;
}

interface UploadEvidence {
  fileRef: Record<string, unknown>;
  content: string;
  sentinel: string;
}

async function runUploadScenario(
  script: ScriptedAuthorResponse[],
  act: (ctx: { client: PgasClient; sessionId: string }) => Promise<UploadEvidence | void>,
): Promise<{ afterRequest: Snapshot; afterUpload: Snapshot; final: Snapshot; upload?: UploadEvidence }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-upload-smoke-'));
  const server = await createPgasServer({
    programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-upload-smoke-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    const created = await client.sessions.create({ program: 'document-anonymizer' });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start generated upload smoke' });
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'request generated document upload' });
    const afterRequest = await readSnapshot(client, sessionId);
    expect(afterRequest.mode).toBe('ingest');
    expect(afterRequest.awaiting?.channelId).toBe('document_upload');
    const upload = await act({ client, sessionId }) ?? undefined;
    let afterUpload = await readSnapshot(client, sessionId);
    let final = afterUpload;
    for (let attempt = 0; attempt < 4 && final.mode !== 'complete'; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue generated upload smoke ${String(attempt + 1)}` });
      final = await readSnapshot(client, sessionId);
    }
    if (afterUpload.mode === 'complete') {
      final = afterUpload;
    } else {
      afterUpload = await readSnapshot(client, sessionId);
    }
    return { afterRequest, afterUpload, final, ...(upload ? { upload } : {}) };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runSkipScenario(
  script: ScriptedAuthorResponse[],
): Promise<{ afterSkip: Snapshot; final: Snapshot }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'pgas-generated-upload-skip-smoke-'));
  const server = await createPgasServer({
    programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
    drivers: {
      authorHandle: scriptedAuthor(script),
      observerHandle: {
        modelId: 'generated-upload-skip-smoke-observer',
        async complete() {
          return 'noop';
        },
      },
    },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  });
  const client = createPgasClient(appTransport(server.app, { token: 'dev-token' }));
  try {
    const created = await client.sessions.create({ program: 'document-anonymizer' });
    const sessionId = created.sessionId;
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start generated optional skip smoke' });
    await client.sessions.trigger(sessionId, {
      channel: 'document_upload',
      payload: { ['inputs.document_intake.status']: 'no_documents_available' },
    });
    const afterSkip = await readSnapshot(client, sessionId);
    let final = afterSkip;
    for (let attempt = 0; attempt < 4 && final.mode !== 'complete'; attempt += 1) {
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue generated optional skip smoke ${String(attempt + 1)}` });
      final = await readSnapshot(client, sessionId);
    }
    return { afterSkip, final };
  } finally {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function uploadText(client: PgasClient, sessionId: string, name: string, content: string): Promise<unknown> {
  const form = new FormData();
  const file = new File([content], name, { type: 'text/plain' });
  form.append('files', file as unknown as Blob, file.name);
  return client.files.upload(sessionId, form);
}

function refsFromUpload(response: unknown): Array<Record<string, unknown>> {
  if (isRecord(response) && Array.isArray(response.files)) {
    return response.files.filter(isRecord);
  }
  return [];
}

async function readSnapshot(client: PgasClient, sessionId: string): Promise<Snapshot> {
  const [envelope, world] = await Promise.all([
    client.sessions.get(sessionId),
    client.sessions.world(sessionId),
  ]);
  const state = envelope.state as Record<string, unknown> | undefined;
  return {
    mode: firstString(envelope.mode, state?.mode),
    domain: world.domain as Record<string, unknown>,
    awaiting: isRecord(state?.awaitingUserDecision) ? state.awaitingUserDecision : undefined,
  };
}

function resultAt(domain: Record<string, unknown>, pathKey: string): Record<string, unknown> {
  const direct = domain[pathKey];
  if (isRecord(direct)) {
    return direct;
  }
  const prefix = `${pathKey}.`;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(domain)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function documentRefLanded(domain: Record<string, unknown>, fileId: string): boolean {
  const refs = domain['inputs.document_intake.file_refs'];
  if (Array.isArray(refs) && refs.some((ref) => isRecord(ref) && ref.fileId === fileId)) {
    return true;
  }
  if (domain['inputs.document_intake.file_refs.0.fileId'] === fileId) {
    return true;
  }
  const first = domain['inputs.document_intake.file_refs.0'];
  return isRecord(first) && first.fileId === fileId;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function scriptedAuthor(responses: ScriptedAuthorResponse[]) {
  let index = 0;
  return {
    modelId: 'generated-upload-smoke-author',
    async complete() {
      const response = responses[index++];
      if (!response) {
        throw new Error(`no generated upload smoke author response scripted for call ${String(index - 1)}`);
      }
      return JSON.stringify(response.response);
    },
  };
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

function scripted(response: ReturnType<typeof effect>): ScriptedAuthorResponse {
  return { response };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
