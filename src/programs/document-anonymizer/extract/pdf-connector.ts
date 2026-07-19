// PDF host-connector seam (declared capability gap).
//
// General PDF text extraction is NOT synthesizable by the pgas-new foundry: it
// requires host-side font/CMap/ToUnicode semantics (subset fonts make naive
// byte-scraping fail open). DOCX/MD/TXT are handled self-contained by the
// generated extractor; PDF input is enabled only when a host implementation of
// DocumentExtractionHostConnector is wired in.
//
// Scanned/image-only PDFs (OCR) are permanently out of scope.

export interface PdfExtractionRequest {
  readonly file_ref: { readonly fileId: string; readonly name: string };
  /** raw PDF bytes, base64-encoded, if the host injects them */
  readonly content_base64?: string;
}

export interface PdfExtractionResult {
  readonly full_text: string;
  readonly char_count: number;
  readonly extraction_kind: 'pdf_host';
}

export interface DocumentExtractionHostConnector {
  extractPdf(request: PdfExtractionRequest): Promise<PdfExtractionResult>;
}

/** Declared, machine-readable capability gap for PDF input. */
export const pdfExtractionGap = {
  capability: 'document_extraction_pdf',
  status: 'host_required' as const,
  reason: 'General PDF text extraction requires host-side font/CMap semantics; not synthesizable by the foundry.',
  wire_hint: 'Implement DocumentExtractionHostConnector (e.g. pdf.js, pdftotext, or a cloud extractor) and route document_upload PDF refs to it before detect_pii.',
};

/**
 * Default stub used until a host connector is provided. It fails closed: PDF
 * input is refused with an explicit, actionable error rather than silently
 * emitting un-extracted or wrong content.
 */
export class UnwiredPdfConnector implements DocumentExtractionHostConnector {
  async extractPdf(_request: PdfExtractionRequest): Promise<PdfExtractionResult> {
    void _request;
    throw new Error(
      'PDF extraction host connector is not wired. ' + pdfExtractionGap.wire_hint,
    );
  }
}
