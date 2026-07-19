import { File } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { appTransport, createPgasClient } from '@simodelne/pgas-server/client.js';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

// Multi-line PDF (each line fits the page so no glyphs are dropped).
function makePdf(lines: string[]): Uint8Array {
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const esc = (s: string) => s.replace(/([()\\])/g, '\\$1');
  const body = lines.map((l, i) => `${i === 0 ? '72 720 Td' : '0 -18 Td'} (${esc(l)}) Tj`).join('\n');
  const stream = `BT /F1 12 Tf\n${body}\nET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const off: number[] = [];
  objs.forEach((b, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of off) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function effect(name: string, payload: Record<string, unknown>, channel = 'widget_output') {
  return { actions: [{ kind: 'EffectAction', name, channel, payload }] };
}

describe('hermetic PDF upload through the engine route', () => {
  it('extracts an uploaded PDF into inputs.source_document (pdf_pdfjs)', async () => {
    const nonce = 'PDFROUTE7';
    const script = [effect('begin_work', {}), effect('request_documents', {}), effect('ingest_documents', {}, 'stage_output')];
    let i = 0;
    const author = { modelId: 'pdf-upload-author', async complete() { const r = script[i++]; if (!r) throw new Error('out of script'); return JSON.stringify(r); } };
    const observer = { modelId: 'pdf-upload-observer', async complete() { return 'noop'; } };
    const tmp = mkdtempSync(join(tmpdir(), 'pdf-upload-'));
    const server = await createPgasServer({
      programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
      drivers: { authorHandle: author, observerHandle: observer },
      devMode: true, storage: { uploadsDir: join(tmp, 'up') }, telemetry: { enabled: false }, port: 0,
    } as never);
    const client = createPgasClient(appTransport((server as { app: unknown }).app as never, { token: 'dev-token' }));
    try {
      const { sessionId } = await client.sessions.create({ program: 'document-anonymizer' });
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'start' });
      await client.sessions.trigger(sessionId, { channel: 'user_text', payload: 'request upload' });
      const form = new FormData();
      const file = new File([makePdf(['Patient Dana Wells', `email dana.${nonce}@example.com`, `case CASE-${nonce}`])], 'intake.pdf', { type: 'application/pdf' });
      form.append('files', file as unknown as Blob, file.name);
      const upload = await client.files.upload(sessionId, form) as { files?: Array<{ fileId: string; name: string }> };
      const ref = (upload.files ?? [])[0];
      expect(ref?.fileId).toEqual(expect.any(String));
      await client.sessions.trigger(sessionId, { channel: 'document_upload', payload: { ['inputs.document_intake.file_refs']: [{ fileId: ref.fileId, name: ref.name }] } });
      const world = await client.sessions.world(sessionId);
      const domain = world.domain as Record<string, unknown>;
      const get = (k: string) => domain[`inputs.source_document.${k}`];
      expect(get('status')).toBe('extracted');
      expect(get('extraction_kind')).toBe('pdf_pdfjs');
      expect(typeof get('full_text')).toBe('string');
      expect(String(get('full_text'))).toContain(nonce);
      expect(String(get('full_text'))).toContain('Dana Wells');
      expect(Number(get('char_count'))).toBeGreaterThan(0);
    } finally {
      await (server as { close?: () => Promise<void> }).close?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
