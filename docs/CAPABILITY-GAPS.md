# Capability gaps

Declared gaps in the synthesized `document-anonymizer` program. Everything else
(DOCX / Markdown / plain-text input, PII detection, deterministic reversible
anonymization, DOCX output, mapping artifact, rehydrate) is implemented and
verified.

## `document_extraction_pdf` — host connector required

PDF **input** is not functional out of the box. General PDF text extraction
needs host-side font/CMap/ToUnicode handling (subset fonts defeat naive
scraping), which the pgas-new foundry does not synthesize. A typed seam is
provided at `src/programs/document-anonymizer/extract/pdf-connector.ts`
(`DocumentExtractionHostConnector`); wire a host implementation (pdf.js,
`pdftotext`, or a cloud extractor) and route `document_upload` PDF refs to it
before `detect_pii`. Until then PDF uploads are not accepted; DOCX/MD/TXT work.

Scanned / image-only PDFs (OCR) are permanently out of scope.

## PDF / style-preserving DOCX **output**

Output DOCX is a clean re-render of the anonymized text (`export_docx_plain`);
original styling/layout/images are not preserved (in-place OOXML editing is
host-side). PDF output would likewise require a host renderer.
