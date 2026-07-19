import { createHash } from 'node:crypto';
import type { HandlerPayload } from './handlers/_resolver.js';

export type StageArchetype = 'pure-compute' | 'llm-reasoning' | 'external-adapter';

export interface StageDomainSpec {
  reads: readonly string[];
  produces: Record<string, unknown>;
  rules: readonly string[];
  invariants: readonly string[];
}

export interface StageInput {
  stage: string;
  payload: HandlerPayload;
  domain: Record<string, unknown>;
  domain_spec: StageDomainSpec;
}

export interface StageRuntime {
  now(): string;
  random(): number;
  llm(prompt: string): Promise<string>;
}

export interface StageOutput {
  result_json: string;
  items_json: string;
  digest: string;
  adapter_kind?: 'in_memory_mock' | 'repo_integration';
}

export const stageClassification = [
  {
    "slug": "intake",
    "archetype": "pure-compute",
    "rationale": "pure compute: intake can be implemented as deterministic local logic against the frozen stage contract."
  },
  {
    "slug": "ingest",
    "archetype": "pure-compute",
    "rationale": "pure compute: ingest can be implemented as deterministic local logic against the frozen stage contract."
  },
  {
    "slug": "detect_pii",
    "archetype": "llm-reasoning",
    "rationale": "llm reasoning: detect_pii was explicitly marked as an LLM reasoning stage in Q5 delegation."
  },
  {
    "slug": "anonymize",
    "archetype": "pure-compute",
    "rationale": "pure compute: anonymize can be implemented as deterministic local logic against the frozen stage contract."
  },
  {
    "slug": "export_anonymized",
    "archetype": "pure-compute",
    "export_kind": "export_docx",
    "rationale": "pure compute export: export_anonymized is bound to export_docx descriptor export_anonymized.output."
  },
  {
    "slug": "rehydrate",
    "archetype": "pure-compute",
    "rationale": "pure compute: rehydrate can be implemented as deterministic local logic against the frozen stage contract."
  },
  {
    "slug": "export_restored",
    "archetype": "pure-compute",
    "export_kind": "export_docx",
    "rationale": "pure compute export: export_restored is bound to export_docx descriptor export_restored.output."
  },
  {
    "slug": "finalize",
    "archetype": "pure-compute",
    "rationale": "pure compute: finalize can be implemented as deterministic local logic against the frozen stage contract."
  },
  {
    "slug": "complete",
    "archetype": "pure-compute",
    "rationale": "pure compute: complete can be implemented as deterministic local logic against the frozen stage contract."
  }
] as const;

export const stageDomainSpecs = {
  "detect_pii": {
    "reads": [
      "inputs.source_document.full_text"
    ],
    "produces": {
      "result_json": {
        "entities": "array",
        "entity_count": "number",
        "summary": "string"
      },
      "items_json": [
        "entity:<summary>"
      ]
    },
    "rules": [
      "Identify every PII entity and classify each as PERSON, EMAIL, PHONE, ADDRESS, ORG, ID, or DATE."
    ],
    "invariants": [
      "each entity has a verbatim text span and a type."
    ]
  },
  "anonymize": {
    "reads": [
      "inputs.source_document.full_text",
      "detect_pii.result_json"
    ],
    "produces": {
      "result_json": {
        "stage": "string",
        "output_text": "string",
        "format": "string",
        "mapping": "array",
        "entity_count": "number"
      },
      "items_json": [
        "token:<token>"
      ]
    },
    "rules": [
      "Assign one stable typed token per unique original PII string; deterministic replace; invertible mapping."
    ],
    "invariants": [
      "mapping backward reproduces original."
    ]
  },
  "export_anonymized": {
    "reads": [
      "anonymize.output.result_json"
    ],
    "produces": {
      "result_json": {
        "stage": "string",
        "docx_base64": "string",
        "docx_bytes": "number",
        "sha256": "string",
        "section_count": "number"
      },
      "items_json": [
        "docx_export:<sha256>"
      ]
    },
    "rules": [
      "Render anonymized output_text into DOCX."
    ],
    "invariants": [
      "No LLM during render."
    ]
  },
  "rehydrate": {
    "reads": [
      "inputs.source_document.full_text",
      "inputs.initial_user_text"
    ],
    "produces": {
      "result_json": {
        "stage": "string",
        "output_text": "string",
        "format": "string",
        "restored_count": "number"
      },
      "items_json": [
        "restored:<token>"
      ]
    },
    "rules": [
      "Reverse anonymization using the mapping."
    ],
    "invariants": [
      "No token remains."
    ]
  },
  "export_restored": {
    "reads": [
      "rehydrate.output.result_json"
    ],
    "produces": {
      "result_json": {
        "stage": "string",
        "docx_base64": "string",
        "docx_bytes": "number",
        "sha256": "string",
        "section_count": "number"
      },
      "items_json": [
        "docx_export:<sha256>"
      ]
    },
    "rules": [
      "Render restored output_text into DOCX."
    ],
    "invariants": [
      "No LLM during render."
    ]
  }
} as Record<string, StageDomainSpec>;

export const stageActionContracts = [
  {
    "action": "advance_ingest_to_detect_pii",
    "stage": "ingest",
    "target": "detect_pii",
    "archetype": "pure-compute",
    "output_path": "ingest.output",
    "guard_path": "inputs.source_document_ready"
  },
  {
    "action": "advance_ingest_to_rehydrate",
    "stage": "ingest",
    "target": "rehydrate",
    "archetype": "pure-compute",
    "output_path": "ingest.output",
    "guard_path": "ingest.rehydrate_selected"
  },
  {
    "action": "complete_detect_pii",
    "stage": "detect_pii",
    "target": "anonymize",
    "archetype": "llm-reasoning",
    "output_path": "detect_pii.result_json",
    "guard_path": "detect_pii.ready"
  },
  {
    "action": "complete_anonymize",
    "stage": "anonymize",
    "target": "export_anonymized",
    "archetype": "pure-compute",
    "output_path": "anonymize.output",
    "guard_path": "anonymize.ready"
  },
  {
    "action": "complete_export_anonymized",
    "stage": "export_anonymized",
    "target": "finalize",
    "archetype": "pure-compute",
    "output_path": "export_anonymized.output",
    "guard_path": "export_anonymized.ready",
    "export_kind": "export_docx"
  },
  {
    "action": "complete_rehydrate",
    "stage": "rehydrate",
    "target": "export_restored",
    "archetype": "pure-compute",
    "output_path": "rehydrate.output",
    "guard_path": "rehydrate.ready"
  },
  {
    "action": "complete_export_restored",
    "stage": "export_restored",
    "target": "finalize",
    "archetype": "pure-compute",
    "output_path": "export_restored.output",
    "guard_path": "export_restored.ready",
    "export_kind": "export_docx"
  },
  {
    "action": "complete_finalize",
    "stage": "finalize",
    "target": "complete",
    "archetype": "pure-compute",
    "output_path": "finalize.output",
    "guard_path": "finalize.ready"
  }
] as const;

export function resolveStageInput(payload: HandlerPayload, stage: string): StageInput {
  const domain = payload.domain && typeof payload.domain === 'object' && !Array.isArray(payload.domain)
    ? payload.domain as Record<string, unknown>
    : {};
  return { stage, payload, domain, domain_spec: stageDomainSpecs[stage] ?? emptyStageDomainSpec };
}

export function createStageRuntime(payload: HandlerPayload): StageRuntime {
  const runtime = payload.__stage_runtime;
  const fixedNow = runtime && typeof runtime === 'object' && !Array.isArray(runtime) && typeof (runtime as { now_iso?: unknown }).now_iso === 'string'
    ? (runtime as { now_iso: string }).now_iso
    : '1970-01-01T00:00:00.000Z';
  const fixedRandom = runtime && typeof runtime === 'object' && !Array.isArray(runtime) && typeof (runtime as { random?: unknown }).random === 'number'
    ? (runtime as { random: number }).random
    : 0.5;
  return {
    now: () => fixedNow,
    random: () => fixedRandom,
    llm: async () => {
      throw new Error('StageRuntime.llm is not available inside deterministic generated wrappers.');
    },
  };
}

export function normalizeStageOutput(
  output: unknown,
  stage: string,
  archetype: StageArchetype,
  adapterKind?: StageOutput['adapter_kind'],
): StageOutput {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`stage ${stage} returned a non-object output`);
  }
  const candidate = output as Partial<StageOutput>;
  const resultJson = assertJsonString(candidate.result_json, `${stage}.result_json`, 'object');
  const itemsJson = assertJsonString(candidate.items_json, `${stage}.items_json`, 'array');
  const normalized: StageOutput = {
    result_json: resultJson,
    items_json: itemsJson,
    digest: digestStageOutput(resultJson, itemsJson),
  };
  if (archetype === 'external-adapter') {
    normalized.adapter_kind = adapterKind ?? 'in_memory_mock';
  }
  assertNoStubMarkers(normalized, stage);
  return normalized;
}

export function digestStageOutput(resultJson: string, itemsJson: string): string {
  return createHash('sha256').update(resultJson).update('\n').update(itemsJson).digest('hex');
}

function assertJsonString(value: unknown, label: string, topLevel: 'object' | 'array'): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a JSON string`);
  }
  const parsed = JSON.parse(value) as unknown;
  if (topLevel === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must encode a JSON ${topLevel}`);
  }
  return JSON.stringify(parsed);
}

function assertNoStubMarkers(output: StageOutput, stage: string): void {
  const text = JSON.stringify(output).toLowerCase();
  for (const marker of ['stage_action_stub', '"todo"', 'replace this stub', 'not implemented']) {
    if (text.includes(marker)) {
      throw new Error(`stage ${stage} output contains stub marker: ${marker}`);
    }
  }
}

const emptyStageDomainSpec: StageDomainSpec = {
  reads: [],
  produces: {},
  rules: [],
  invariants: [],
};
