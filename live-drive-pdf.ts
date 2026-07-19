// Live PDF smoke: upload a real PDF with PII, drive to complete on a real
// provider (qwen36-27b), assert PDF extraction + anonymization + reversibility.
process.env.PGAS_PROVIDER = 'openai';
process.env.PGAS_OPENAI_BASE_URL = process.env.PGAS_OPENAI_BASE_URL ?? 'http://localhost:8000/v1';
process.env.PGAS_OPENAI_MODEL = process.env.PGAS_OPENAI_MODEL ?? 'qwen36-27b';
process.env.PGAS_MODEL = process.env.PGAS_MODEL ?? 'qwen36-27b';
process.env.PGAS_OPENAI_API_KEY = process.env.PGAS_OPENAI_API_KEY ?? 'local';
process.env.PGAS_OPENAI_TOOL_CHOICE = process.env.PGAS_OPENAI_TOOL_CHOICE ?? 'required';
process.env.PGAS_OPENAI_DISABLE_THINKING = process.env.PGAS_OPENAI_DISABLE_THINKING ?? '1';
process.env.PGAS_OPENAI_TEMPERATURE = process.env.PGAS_OPENAI_TEMPERATURE ?? '0.2';
process.env.PGAS_ROUND_TIMEOUT_MS = process.env.PGAS_ROUND_TIMEOUT_MS ?? '600000';

import { File } from 'node:buffer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderHandles } from '@simodelne/pgas-server/plugin.js';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createDocumentAnonymizerProgramEntry } from './src/programs/document-anonymizer/registration.js';

const NONCE = 'PDFX' + String(Date.now()).slice(-8);
const LINES = [
  'CONFIDENTIAL INTAKE',
  'Patient Dana Wells',
  'email dana.' + NONCE + '@example.com',
  'phone +1-202-555-0111',
  'case CASE-' + NONCE,
  'seen at Meridian Clinic',
];

function makePdf(lines: string[]): Uint8Array {
  const objs: string[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const esc = (s: string) => s.replace(/([()\\])/g, '\\$1');
  const body = lines.map((line, i) => `${i === 0 ? '72 720 Td' : '0 -18 Td'} (${esc(line)}) Tj`).join('\n');
  const stream = `BT /F1 12 Tf\n${body}\nET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((b, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

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
  process.stdout.write(`[pdf-live] author=${(authorHandle as any).modelId} nonce=${NONCE}\n`);
  const tempDir = mkdtempSync(join(tmpdir(), 'pdf-live-'));
  const server = await createPgasServer({
    programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
    drivers: { authorHandle, observerHandle, authorMode: 'json' },
    devMode: true, storage: { uploadsDir: join(tempDir, 'uploads') }, telemetry: { enabled: false }, port: 0,
  } as never);
  const client = createPgasClient(appTransport((server as any).app, { token: 'dev-token' }));

  const created = await client.sessions.create({ program: 'document-anonymizer' });
  const sessionId = created.sessionId;
  process.stdout.write(`[pdf-live] session=${sessionId}\n`);

  await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'Please anonymize the PDF I will upload. Remove all PII and give me a reversible mapping.' });
  let snap = await snapshot(client, sessionId);
  process.stdout.write(`[pdf-live] mode=${snap.mode}\n`);
  for (let i = 0; i < 4 && snap.awaiting?.channelId !== 'document_upload' && snap.mode !== 'ingest'; i += 1) {
    await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'Go ahead and request the upload.' });
    snap = await snapshot(client, sessionId);
    process.stdout.write(`[pdf-live] mode=${snap.mode} awaiting=${snap.awaiting?.channelId ?? '-'}\n`);
  }

  const form = new FormData();
  const file = new File([makePdf(LINES)], 'intake.pdf', { type: 'application/pdf' });
  form.append('files', file as unknown as Blob, file.name);
  const upload: any = await client.files.upload(sessionId, form);
  const fileRef = (upload?.files ?? [])[0];
  process.stdout.write(`[pdf-live] uploaded fileId=${fileRef?.fileId}\n`);
  await client.sessions.trigger(sessionId, { channel: 'document_upload', payload: { ['inputs.document_intake.file_refs']: [{ fileId: fileRef.fileId, name: fileRef.name }] } });

  let final = await snapshot(client, sessionId);
  for (let i = 0; i < 16 && final.mode !== 'complete'; i += 1) {
    try {
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: `continue ${String(i + 1)}` });
    } catch (err) {
      if (String((err as Error).message).toLowerCase().includes('terminal')) { process.stdout.write('[pdf-live] session terminal (completed)\n'); break; }
      throw err;
    }
    final = await snapshot(client, sessionId);
    process.stdout.write(`[pdf-live] mode=${final.mode}\n`);
  }
  final = await snapshot(client, sessionId);

  const srcFull = typeof final.domain['inputs.source_document.full_text'] === 'string' ? final.domain['inputs.source_document.full_text'] as string : '';
  const extractionKind = typeof final.domain['inputs.source_document.extraction_kind'] === 'string' ? final.domain['inputs.source_document.extraction_kind'] as string : '';
  const anon = pickStage(final.domain, 'anonymize') ?? {};
  const outputText = typeof anon.output_text === 'string' ? anon.output_text : '';
  const mapping = Array.isArray(anon.mapping) ? anon.mapping as Array<{ token: string; original: string }> : [];
  let restored = outputText;
  for (const m of mapping) { if (m && typeof m.token === 'string' && typeof m.original === 'string') restored = restored.split(m.token).join(m.original); }

  const pdfExtracted = extractionKind.includes('pdf') && srcFull.includes(NONCE);
  const nonceInOutput = outputText.includes(NONCE);
  const nonceInMapping = mapping.some((m) => typeof m?.original === 'string' && m.original.includes(NONCE));
  const roundTrips = restored === srcFull && srcFull.length > 0;

  process.stdout.write('\n=== DOCUMENT-ANONYMIZER PDF LIVE-DRIVE VERDICT ===\n');
  process.stdout.write(`final_mode=${final.mode} extraction_kind=${extractionKind}\n`);
  process.stdout.write(`source_full_text_len=${srcFull.length} output_text_len=${outputText.length} mapping_entries=${mapping.length}\n`);
  process.stdout.write(`pdf_extracted_with_nonce=${pdfExtracted} nonce_in_output=${nonceInOutput} nonce_in_mapping=${nonceInMapping} reverse_byte_exact=${roundTrips}\n`);
  process.stdout.write(`pdf_anonymize_engaged=${pdfExtracted && !nonceInOutput && nonceInMapping && roundTrips && mapping.length > 0}\n`);
  process.stdout.write(`--- source (extracted from PDF, first 200) ---\n${srcFull.slice(0, 200)}\n`);
  process.stdout.write(`--- anonymized output (first 200) ---\n${outputText.slice(0, 200)}\n`);

  await (server as any).close?.();
  process.exit(0);
}
main().catch((e) => { process.stderr.write(`[pdf-live] FATAL: ${String(e?.stack ?? e)}\n`); process.exit(1); });
