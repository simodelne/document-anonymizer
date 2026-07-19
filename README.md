# document-anonymizer

A **reversible document anonymizer** — a standalone [PGAS](https://www.npmjs.com/package/@simodelne/pgas-server) program **synthesized by the `pgas-new` foundry** (not hand-written). It takes a document, replaces every piece of personally-identifying information (PII) with a stable typed token, and returns the same-format document plus a separate **mapping file** that lets you rebuild the original exactly.

Anonymization is **reversible and deterministic**: applying the mapping backward over the anonymized text reproduces the source **byte-for-byte**.

## What it does

- **Input:** DOCX, Markdown, or plain text (PDF is a declared host-connector gap — see below).
- **Detect:** an LLM stage identifies PII entities — `PERSON`, `EMAIL`, `PHONE`, `ADDRESS`, `ORG`, `ID`, `DATE`.
- **Anonymize:** a deterministic stage assigns one stable typed token per unique original (`[PERSON_1]`, `[EMAIL_2]`, …; the same entity → the same token everywhere) and builds a complete, invertible mapping `[{ token, original, type, occurrences }]`.
- **Output:** the anonymized document in the **same format** (DOCX re-rendered via OOXML; MD/TXT directly) **plus** the mapping as a first-class artifact.
- **Rehydrate:** a built-in reverse flow rebuilds the original from an anonymized document + its mapping.

## How it works

The program is a PGAS state machine. The LLM branches at `ingest` based on the requested operation:

```
intake → ingest ─┬─ detect_pii → anonymize → export_anonymized ─┐
                 │                                              ├─ finalize → complete
                 └─ rehydrate → export_restored ────────────────┘
```

- `detect_pii` is LLM-reasoning; `anonymize`, `rehydrate`, and the extraction/export stages are deterministic.
- Artifacts (anonymized DOCX + `anonymization_mapping`) are harvested as first-class `SessionArtifactRecord`s via the program's `artifactPolicy`.

Program source lives in [`src/programs/document-anonymizer/`](src/programs/document-anonymizer/) (spec, registration, contracts, `stages/`, `handlers/`, `extract/`, `export/`).

## Quick start

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (hermetic; excludes the live-provider gate)
npm run dev         # boot the PGAS server
npm run repl        # interactive REPL
```

Requires Node 18+ (uses `node:zlib`, `FormData`/`File`). Engine: `@simodelne/pgas-server@^3.21.0`.

### Live run against a real provider

The program has been driven end-to-end against a real OpenAI-compatible provider (qwen36-27b on vLLM). See [`live-drive-anon.ts`](live-drive-anon.ts) for a full upload → drive → verify harness. Set:

```bash
export PGAS_PROVIDER=openai
export PGAS_OPENAI_BASE_URL=http://localhost:8000/v1
export PGAS_OPENAI_MODEL=qwen36-27b
export PGAS_ROUND_TIMEOUT_MS=600000   # see Capability gaps → live-run note
npx tsx live-drive-anon.ts
```

## Verification

Live-proven end-to-end on qwen36-27b (`anonymize_engaged=true`: PII removed from output, present in the mapping, byte-exact reversal) and **independently re-verified by a Codex agent** — 4/4 live tests pass (TXT anonymize, real DEFLATE `.docx` anonymize, rehydrate branch, second-document robustness). Evidence: [`audit/`](audit/) (`live-drive-verdict-restructured.txt`, `CODEX-LIVE-TEST.md`).

## Capability gaps

Honest scope — see [`docs/CAPABILITY-GAPS.md`](docs/CAPABILITY-GAPS.md):

- **PDF input/output** is a declared **host-connector gap**. General PDF text extraction needs host-side font/CMap handling the foundry doesn't synthesize; a typed seam is provided at [`src/programs/document-anonymizer/extract/pdf-connector.ts`](src/programs/document-anonymizer/extract/pdf-connector.ts) (`DocumentExtractionHostConnector`). DOCX/MD/TXT work out of the box. Scanned/OCR PDFs are out of scope.
- **DOCX output** is a clean re-render of the anonymized text — original styling/layout/images are not preserved (in-place OOXML editing is host-side).
- **Rehydrate** (v1) reads the mapping from the request payload.
- **Live-run note:** at the deterministic DOCX export round a verbose provider may over-generate; set `PGAS_ROUND_TIMEOUT_MS=600000` so the round finishes.

## Design

Full design doc: [`docs/superpowers/specs/2026-07-19-document-anonymizer-design.md`](docs/superpowers/specs/2026-07-19-document-anonymizer-design.md).

---

Generated with the `pgas-new` foundry. 🤖
