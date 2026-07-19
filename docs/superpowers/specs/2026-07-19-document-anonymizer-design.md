# Document Anonymizer — Design

**Date:** 2026-07-19
**Status:** Approved (offline supervision) — proceed to synthesis
**Built by:** the `pgas-new` foundry (this is a synthesized standalone PGAS program)

## Overview

A standalone PGAS program that **reversibly anonymizes documents**. It takes a
document (DOCX, Markdown, or plain text — PDF as a host-connector gap), detects
personally-identifying information, replaces each entity with a stable typed
placeholder, and returns:

1. the **same document in the same format**, anonymized; and
2. a separate **mapping file** listing every substitution, so the original can
   be rebuilt.

It also exposes a built-in **rehydrate** flow: given an anonymized document plus
its mapping file, it reconstructs the original.

## Structure

**Approach A (default):** a single PGAS program with an operation branch at
intake — `operation ∈ {anonymize, rehydrate}`. One state machine, the user
picks the operation up front.

**Fallback B:** if the foundry cannot synthesize the intake branch cleanly
(its proven strength is linear stage chains), split into **two programs in one
repo** — `anonymize` and `rehydrate`, each a clean linear chain. The build
verifies A falsifier-first and drops to B only on a proven synthesis failure.

## Capability grounding (what the foundry provably synthesizes)

| Concern | Mechanism | Foundry status |
|---|---|---|
| Intake TXT / MD | `document_upload_intake` | synthesizes |
| Intake DOCX | `document_extraction_docx` (`node:zlib` OOXML inflate) | synthesizes |
| Intake PDF | `document_extraction_pdf` (typed host connector) | **scaffolds_with_gap** |
| Detect PII | `stage_archetypes` — llm-reasoning stage | synthesizes |
| Substitute + build mapping | `stage_archetypes` — pure-compute stage | synthesizes |
| Output DOCX | `export_docx_plain` (clean OOXML re-render) | synthesizes |
| Output TXT / MD | first-class text artifact | synthesizes |
| Output mapping.json | first-class artifact | synthesizes |
| Output PDF | no foundry PDF renderer (host connector) | **scaffolds_with_gap** |

Out-of-the-box the program works end-to-end for **DOCX / MD / TXT**. PDF (both
read and write) is a declared, typed host-connector seam that activates only
when a host backend is wired.

## Modes / stages

### Anonymize chain

1. **`intake`** (bootstrap) — receive the request, capture the uploaded
   document, set `source.operation = anonymize`.
2. **`ingest_document`** (external-adapter / pure-compute) — extract text and
   detect format. TXT/MD read directly; DOCX inflated via `node:zlib` and
   parsed from `<w:t>` runs; **PDF routed to the host-connector seam** (gap).
   Produces `source.full_text`, `source.format`.
3. **`detect_pii`** (llm-reasoning) — the LLM scans `source.full_text` and emits
   a list of detected entities `[{ text, type }]` over the categories PERSON,
   EMAIL, PHONE, ADDRESS, ORG, ID, DATE.
4. **`anonymize`** (pure-compute, deterministic) — assign one stable typed
   placeholder per unique original string (`[PERSON_1]`, `[EMAIL_2]`, …; the
   same original → the same placeholder at every occurrence), replace them in
   the text to produce `anonymize.anonymized_text`, and build
   `anonymize.mapping = [{ placeholder, original, type, occurrences }]`.
5. **`export`** — render the anonymized document **in the same format** (DOCX via
   `export_docx_plain`; TXT/MD as a text artifact; PDF via the host seam) **and**
   emit `mapping.json` as a separate first-class artifact.
6. **`complete`** (terminal).

### Rehydrate chain

1. **`intake`** — set `operation = rehydrate`, capture the anonymized document
   and the uploaded `mapping.json`.
2. **`ingest_anonymized`** — extract the anonymized text (same extraction paths)
   and parse the mapping.
3. **`rehydrate`** (pure-compute, deterministic) — for each mapping entry,
   replace `placeholder → original` in the anonymized text → `restored_text`.
4. **`export`** — render the restored document in the same format.
5. **`complete`** (terminal).

## State / data model

```
source.operation        : "anonymize" | "rehydrate"
source.format           : "docx" | "md" | "txt" | "pdf"
source.full_text        : string        # extracted text
pii.entities            : [{ text, type }]
anonymize.anonymized_text : string
anonymize.mapping       : [{ placeholder, original, type, occurrences }]
rehydrate.restored_text : string
```

## Placeholder + mapping contract (the reversibility invariant)

- Each **unique original** PII string maps to exactly **one** placeholder.
- Placeholders are typed + counter-numbered per type: `[PERSON_1]`,
  `[PERSON_2]`, `[EMAIL_1]`, … — readable and collision-resistant (square-bracket
  typed tokens are unlikely to occur in source prose; if a source already
  contains a candidate token, the anonymize stage escalates the counter/nonce).
- The mapping is **complete and invertible**: applying it backward over
  `anonymized_text` reproduces `full_text` exactly. This is the property the
  live-drive asserts (byte-for-byte round trip).
- Substitution is **deterministic** given the detected entity list; the only
  nondeterministic step is *which* entities the LLM flags (inherent to PII
  detection).

## Format routing

| `source.format` | Anonymized output | Notes |
|---|---|---|
| `txt` | `anonymized.txt` | direct |
| `md` | `anonymized.md` | direct |
| `docx` | `anonymized.docx` | `export_docx_plain` — clean re-render; original styling/layout/images not preserved (host-side) |
| `pdf` | host-connector seam | scaffolded gap; needs a host PDF backend |
| (always) | `mapping.json` | separate artifact |

## Error handling

- **No PII detected** → pass through unchanged; mapping is empty but valid;
  round-trip still holds.
- **Unsupported / PDF format without a host backend** → the program lodges the
  `capability_gaps` PDF connector; it does not silently emit a wrong-format or
  un-anonymized artifact.
- **Rehydrate with a mapping that does not fully invert** (placeholder not found
  in text, or leftover placeholders after reverse) → fail loudly with the
  offending entries; do not emit a partially-restored artifact as if complete.

## Testing / verification ladder

1. `typecheck` — the synthesized program + standalone repo compile.
2. static gates — structural checks on the generated scaffold.
3. hermetic smoke — the generated program boots and drives to `complete` with a
   mock provider.
4. **live-drive on qwen (fail-closed `anonymize_engaged` verdict):** upload a
   document seeded with a per-run nonce PII sentinel; assert the nonce is
   **absent** from `anonymized_text`, **present** in `mapping.json`, and that
   reverse-substitution reproduces the original **byte-for-byte**. A stall or
   mock cannot read green.

## Out of scope (v1)

- A real PDF backend (extraction + rendering) — declared as a typed gap only.
- Style/layout-preserving DOCX (in-place OOXML editing) — host-side.
- OCR / scanned documents — permanently out of foundry scope.
- Any frontend/UI or backend service surface (core PGAS + host connectors only).
