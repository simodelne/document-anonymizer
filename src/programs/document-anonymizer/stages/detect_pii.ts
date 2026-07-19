// Runtime locus: this stage executes inside the program's engine author-LLM.
// There is no deterministic runStage here on purpose — the woven specs.yml
// (mode prompt, synthesized arg schema, GKType-typed <stage>.result.* paths)
// is what executes and enforces this stage at runtime. This module is the
// first-class record of that reasoning contract.
export const reasoningContract = {
  "contract_version": "foundry-reasoning-contract-v1",
  "stage": "detect_pii",
  "reasoning_prompt": "You are performing the detect_pii stage of Document Anonymizer.\nProgram purpose: Reversibly anonymize an uploaded document (docx, markdown, or plain text): extract the text, detect PII, replace each entity with a stable typed token, and produce the anonymized document plus a mapping file for rebuilding the original. Also supports a rehydrate operation that rebuilds the original from an anonymized document and its mapping.\nApply these rules exactly: Identify every PII entity and classify each as PERSON, EMAIL, PHONE, ADDRESS, ORG, ID, or DATE.\nRespect these invariants: each entity has a verbatim text span and a type.\nGround your reasoning in the prior stage outputs available in program state: ingest: ingest.output.result_json, ingest.output.items_json.\nWeigh the available evidence, reach an explicit judgment for this stage, and justify it concisely.\nDo not fabricate facts that are not present in the request or prior stage outputs.",
  "result_schema": {
    "fields": [
      {
        "name": "entities",
        "type": "string",
        "description": "Value for entities required by the stage domain spec (declared as: array)."
      },
      {
        "name": "entity_count",
        "type": "number",
        "description": "Value for entity_count required by the stage domain spec (declared as: number)."
      },
      {
        "name": "summary",
        "type": "string",
        "description": "Value for summary required by the stage domain spec (declared as: string)."
      }
    ],
    "allow_extra_fields": true
  },
  "items_schema": {
    "templates": [
      "entity:<summary>"
    ],
    "description": "Item strings declared by the detect_pii domain spec, one per template, in order."
  },
  "canned_example": {
    "result": {
      "entities": "sample entities",
      "entity_count": 1,
      "summary": "sample summary"
    },
    "items": [
      "entity:sample summary"
    ]
  },
  "contract_source": "deterministic_fallback"
} as const;
