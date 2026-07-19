// Live-drive of the synthesized document-anonymizer on a real provider (qwen36-27b).
// Uploads a PII document, drives to complete, asserts the reversibility invariant.
process.env.PGAS_PROVIDER = 'openai';
process.env.PGAS_OPENAI_BASE_URL = process.env.PGAS_OPENAI_BASE_URL ?? 'http://localhost:8000/v1';
process.env.PGAS_OPENAI_MODEL = process.env.PGAS_OPENAI_MODEL ?? 'qwen36-27b';
process.env.PGAS_MODEL = process.env.PGAS_MODEL ?? 'qwen36-27b';
process.env.PGAS_OPENAI_API_KEY = process.env.PGAS_OPENAI_API_KEY ?? 'local';
process.env.PGAS_OPENAI_TOOL_CHOICE = process.env.PGAS_OPENAI_TOOL_CHOICE ?? 'required';
process.env.PGAS_OPENAI_DISABLE_THINKING = process.env.PGAS_OPENAI_DISABLE_THINKING ?? '1';
process.env.PGAS_OPENAI_TEMPERATURE = process.env.PGAS_OPENAI_TEMPERATURE ?? '0.2';

import { File } from 'node:buffer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderHandles } from '@simodelne/pgas-server/plugin.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createDocumentAnonymizerProgramEntry } from './src/programs/document-anonymizer/registration.js';

const NONCE = 'NX' + String(Date.now()).slice(-8);
const ORIGINAL = [
  'CONFIDENTIAL MEMO',
  '',
  'From: Alice Johnson (alice.johnson.' + NONCE + '@example.com), phone +1-202-555-0173.',
  'To: Bob Smith at Acme Corporation, 123 Main Street, Springfield.',
  'Re: settlement for client Carol Danvers, case reference CASE-' + NONCE + '-4471.',
  '',
  'Alice Johnson will follow up with Bob Smith next week. Acme Corporation confirmed.',
].join('\n');

function pickStage(domain: Record<string, unknown>, stage: string): Record<string, unknown> | undefined {
  const obj = domain[`${stage}.output`];
  if (obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>).result_json === 'string') {
    try { return JSON.parse((obj as Record<string, unknown>).result_json as string) as Record<string, unknown>; } catch { return undefined; }
  }
  const flat = domain[`${stage}.output.result_json`];
  if (typeof flat === 'string') { try { return JSON.parse(flat) as Record<string, unknown>; } catch { return undefined; } }
  return undefined;
}

async function snapshot(client: any, sessionId: string) {
  const [env, world] = await Promise.all([client.sessions.get(sessionId), client.sessions.world(sessionId)]);
  const state = env.state as Record<string, unknown> | undefined;
  const mode = (typeof env.mode === 'string' && env.mode) || (state && typeof state.mode === 'string' ? state.mode : null);
  const awaiting = state && typeof state.awaitingUserDecision === 'object' ? state.awaitingUserDecision as Record<string, unknown> : undefined;
  return { mode, domain: world.domain as Record<string, unknown>, awaiting };
}

async function main() {
  const { authorHandle, observerHandle } = createProviderHandles({ provider: 'openai' });
  process.stdout.write(`[anon-live] author=${(authorHandle as any).modelId}\n`);
  const tempDir = mkdtempSync(join(tmpdir(), 'anon-live-'));
  const server = await createPgasServer({
    programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
    drivers: { authorHandle, observerHandle, authorMode: 'json' },
    devMode: true,
    storage: { uploadsDir: join(tempDir, 'uploads') },
    telemetry: { enabled: false },
    port: 0,
  } as never);
  const client = createPgasClient(appTransport((server as any).app, { token: 'dev-token' }));

  const created = await client.sessions.create({ program: 'document-anonymizer' });
  const sessionId = created.sessionId;
  process.stdout.write(`[anon-live] session=${sessionId} nonce=${NONCE}\n`);

  await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'Please anonymize the document I will upload. Remove all personally identifying information and give me a reversible mapping.' });
  let snap = await snapshot(client, sessionId);
  process.stdout.write(`[anon-live] mode=${snap.mode}\n`);
  // advance until the program awaits the document upload
  for (let i = 0; i < 4 && snap.awaiting?.channelId !== 'document_upload' && snap.mode !== 'ingest'; i += 1) {
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'Go ahead and request the upload.' });
    snap = await snapshot(client, sessionId);
    process.stdout.write(`[anon-live] mode=${snap.mode} awaiting=${snap.awaiting?.channelId ?? '-'}\n`);
  }

  const form = new FormData();
  const file = new File([ORIGINAL], 'memo.txt', { type: 'text/plain' });
  form.append('files', file as unknown as Blob, file.name);
  const upload: any = await client.files.upload(sessionId, form);
  const fileRef = (upload?.files ?? [])[0];
  process.stdout.write(`[anon-live] uploaded fileId=${fileRef?.fileId}\n`);
  await client.sessions.trigger(sessionId, { channel: 'document_upload', payload: { ['inputs.document_intake.file_refs']: [{ fileId: fileRef.fileId, name: fileRef.name }] } });

  let final = await snapshot(client, sessionId);
  for (let i = 0; i < 16 && final.mode !== 'complete'; i += 1) {
    try {
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue ${String(i + 1)}` });
    } catch (err) {
      if (String((err as Error).message).toLowerCase().includes('terminal')) { process.stdout.write('[anon-live] session terminal (completed)\n'); break; }
      throw err;
    }
    final = await snapshot(client, sessionId);
    process.stdout.write(`[anon-live] mode=${final.mode}\n`);
  }
  final = await snapshot(client, sessionId);

  const source = pickStage(final.domain, 'ingest') ?? {};
  const srcFull = typeof final.domain['inputs.source_document.full_text'] === 'string' ? final.domain['inputs.source_document.full_text'] as string : '';
  const anon = pickStage(final.domain, 'anonymize') ?? {};
  const outputText = typeof anon.output_text === 'string' ? anon.output_text : '';
  const mapping = Array.isArray(anon.mapping) ? anon.mapping as Array<{ token: string; original: string }> : [];

  // reversibility: apply mapping backward over output_text
  let restored = outputText;
  for (const m of mapping) { if (m && typeof m.token === 'string' && typeof m.original === 'string') restored = restored.split(m.token).join(m.original); }

  const nonceInOriginal = srcFull.includes(NONCE);
  const nonceInOutput = outputText.includes(NONCE);
  const nonceInMapping = mapping.some((m) => typeof m?.original === 'string' && m.original.includes(NONCE));
  const roundTrips = restored === srcFull && srcFull.length > 0;

  process.stdout.write('\n=== DOCUMENT-ANONYMIZER LIVE-DRIVE VERDICT ===\n');
  process.stdout.write(`final_mode=${final.mode}\n`);
  process.stdout.write(`source_full_text_len=${srcFull.length} output_text_len=${outputText.length} mapping_entries=${mapping.length}\n`);
  process.stdout.write(`nonce_in_original=${nonceInOriginal} nonce_in_output=${nonceInOutput} nonce_in_mapping=${nonceInMapping} reverse_byte_exact=${roundTrips}\n`);
  process.stdout.write(`anonymize_engaged=${nonceInOriginal && !nonceInOutput && nonceInMapping && roundTrips && mapping.length > 0}\n`);
  process.stdout.write(`--- sample mapping (first 4) ---\n${JSON.stringify(mapping.slice(0, 4), null, 2)}\n`);
  process.stdout.write(`--- output_text (first 240) ---\n${outputText.slice(0, 240)}\n`);
  void source;

  await (server as any).close?.();
  process.exit(0);
}
main().catch((e) => { process.stderr.write(`[anon-live] FATAL: ${String(e?.stack ?? e)}\n`); process.exit(1); });
