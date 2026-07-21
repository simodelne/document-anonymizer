# Document Anonymizer Frontend

Run:

```bash
npm run frontend
```

Open:

```text
http://localhost:5178
```

Set `PORT` to bind a different port. The server binds `0.0.0.0` and prints `document-anonymizer frontend on http://localhost:<port>` after startup.

The BFF starts one in-process PGAS server and uses a fresh PGAS session for each anonymize or rehydrate request. It sets local defaults for qwen36-27b on vLLM, so `npm run frontend` expects an OpenAI-compatible vLLM server reachable at:

```text
http://localhost:8000/v1
```

Known limits:

- Scanned/OCR PDFs are unsupported.
- DOCX source text can be anonymized or rehydrated; the browser path returns the result text and does not preserve the source layout.
- PDF anonymized output is returned as extracted text; the frontend does not render a new PDF.
