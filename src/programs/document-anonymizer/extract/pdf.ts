// Real PDF text extraction via pdfjs-dist (Mozilla) — a portable, pure-JS host
// connector. This closes the `document_extraction_pdf` gap: general PDF text
// extraction needs host-side font/CMap/ToUnicode handling, which pdfjs provides.
// No system binary is required. Scanned / image-only PDFs yield no text (OCR is
// out of scope) and fail closed with an explicit reason.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type ExtractPdfResult =
  | { ok: true; text: string; char_count: number; page_count: number }
  | { ok: false; reason: string };

// pdfjs-dist is ESM and non-trivial to load; import it lazily so it is only
// resolved when a PDF actually arrives.
let pdfjsPromise: Promise<Record<string, unknown>> | undefined;
function loadPdfjs(): Promise<Record<string, unknown>> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<Record<string, unknown>>;
  }
  return pdfjsPromise;
}

// Point pdfjs at its bundled standard-14 font metrics (suppresses the runtime
// warning and improves fidelity for non-embedded standard fonts). Best-effort:
// if resolution fails, extraction still works for embedded-font PDFs.
function standardFontDataUrl(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const root = dirname(req.resolve('pdfjs-dist/package.json'));
    return `${pathToFileURL(join(root, 'standard_fonts')).href}/`;
  } catch {
    return undefined;
  }
}

interface PdfTextItem { str?: unknown }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
type GetDocument = (params: Record<string, unknown>) => { promise: Promise<PdfDocument> };

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractPdfResult> {
  try {
    const pdfjs = await loadPdfjs();
    const getDocument = pdfjs.getDocument as GetDocument;
    const doc = await getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: standardFontDataUrl(),
    }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (typeof it.str === 'string' ? it.str : '')).join(' '));
    }
    await doc.destroy();
    const text = pages.join('\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (text.length === 0) {
      return { ok: false, reason: 'no extractable text (likely a scanned/image-only PDF — OCR is out of scope)' };
    }
    return { ok: true, text, char_count: text.length, page_count: doc.numPages };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
