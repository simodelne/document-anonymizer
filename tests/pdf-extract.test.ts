import { describe, it, expect } from 'vitest';
import { extractPdfText } from '../src/programs/document-anonymizer/extract/pdf.js';

// Minimal valid single-page PDF with a text object (Helvetica), computing xref
// byte offsets so pdfjs parses it. Each line is emitted with its own Td offset
// and kept short so it fits within the page width (off-page glyphs get dropped
// by every extractor, pdfjs and pdftotext alike).
function makePdf(lines: string[]): Uint8Array {
  const objs: string[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const esc = (s: string) => s.replace(/([()\\])/g, '\\$1');
  const body = lines.map((line, i) => `${i === 0 ? '72 700 Td' : '0 -18 Td'} (${esc(line)}) Tj`).join('\n');
  const stream = `BT /F1 12 Tf\n${body}\nET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('extractPdfText', () => {
  it('extracts text from a real PDF (pdfjs-dist)', async () => {
    const nonce = 'PDFUNITNONCE42';
    const lines = [
      'Patient Dana Wells',
      `email dana.${nonce}@example.com`,
      `case CASE-${nonce}`,
      'at Meridian Clinic',
    ];
    const result = await extractPdfText(makePdf(lines));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(nonce);
    expect(result.text).toContain('Dana Wells');
    expect(result.text).toContain('Meridian Clinic');
    expect(result.text).toContain(`dana.${nonce}@example.com`);
    expect(result.char_count).toBe(result.text.length);
    expect(result.page_count).toBe(1);
  }, 30_000);

  it('fails closed on non-PDF bytes', async () => {
    const result = await extractPdfText(new Uint8Array(Buffer.from('this is not a pdf', 'utf8')));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  }, 30_000);
});
