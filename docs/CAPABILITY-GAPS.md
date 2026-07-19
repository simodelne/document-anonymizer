# Capability gaps

Declared gaps in the synthesized `document-anonymizer` program. Everything else
(DOCX / Markdown / plain-text input, PII detection, deterministic reversible
anonymization, DOCX output, mapping artifact, rehydrate) is implemented and
verified.

## `document_extraction_pdf` — WIRED (host connector)

PDF **input works**. General PDF text extraction needs host-side
font/CMap/ToUnicode handling (subset fonts defeat naive scraping), which the
pgas-new foundry does not synthesize — so it is provided as a host connector at
`src/programs/document-anonymizer/extract/pdf.ts` (`extractPdfText`), backed by
[`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) (Mozilla pdf.js). It is
portable pure-JS — no system binary required. The extraction handler
(`handlers/index.ts`) accepts `application/pdf`, decodes the engine-injected
`content_base64`, and routes it through `extractPdfText` before `detect_pii`
(`extraction_kind: pdf_pdfjs`).

To swap the backend (e.g. `pdftotext`/poppler or a cloud extractor), replace the
body of `extractPdfText` — its `Uint8Array -> {text,char_count}` contract is the
seam. Extraction **fails closed**: an unparseable or text-less PDF returns a
`blocked_extraction_failed` source with an explicit reason rather than silent
empty content.

Scanned / image-only PDFs (OCR) are permanently out of scope — they yield no
extractable text and are refused with a clear reason.

## PDF / style-preserving DOCX **output**

Output DOCX is a clean re-render of the anonymized text (`export_docx_plain`);
original styling/layout/images are not preserved (in-place OOXML editing is
host-side). PDF output would likewise require a host renderer.

## Live-run note: round timeout

At the deterministic DOCX export round, a verbose provider (e.g. qwen36-27b) may
try to author the export payload itself, producing large responses that can
exceed the default 300 s round liveness bound. For live runs set
`PGAS_ROUND_TIMEOUT_MS=600000` (the export body is deterministic; the extra time
only absorbs provider verbosity). Verified: with this set, the program drives
end-to-end to `complete` with `anonymize_engaged=true` (byte-exact reversibility,
9 PII entities, nonce removed from output and present in the mapping).
