import type { ToolRegistry } from '@simodelne/pgas-server/plugin.js';

// Native stage actions are declared in specs.yml action_map. This metadata gives
// implementers one fillable local-tool slot per synthesized stage without adding
// extra invoke_tool_* actions to the engine topology.
export const stageActionTools = {
  advance_ingest_to_detect_pii: {
    mode: 'ingest',
    target: 'detect_pii',
    archetype: 'pure-compute',
    guard_paths: ['inputs.source_document_ready'],
    output_path: 'ingest.output',
    items_path: 'ingest.output.items_json',
    description: 'Generated stage action metadata for ingest.',
  },
  advance_ingest_to_rehydrate: {
    mode: 'ingest',
    target: 'rehydrate',
    archetype: 'pure-compute',
    guard_paths: ['ingest.rehydrate_selected'],
    output_path: 'ingest.output',
    items_path: 'ingest.output.items_json',
    description: 'Generated stage action metadata for ingest.',
  },
  complete_detect_pii: {
    mode: 'detect_pii',
    target: 'anonymize',
    archetype: 'llm-reasoning',
    guard_paths: ['detect_pii.ready'],
    output_path: 'detect_pii.result_json',
    items_path: 'detect_pii.items_json',
    description: 'Generated stage action metadata for detect_pii.',
  },
  complete_anonymize: {
    mode: 'anonymize',
    target: 'export_anonymized',
    archetype: 'pure-compute',
    guard_paths: ['anonymize.ready'],
    output_path: 'anonymize.output',
    items_path: 'anonymize.output.items_json',
    description: 'Generated stage action metadata for anonymize.',
  },
  complete_export_anonymized: {
    mode: 'export_anonymized',
    target: 'finalize',
    archetype: 'pure-compute',
    guard_paths: ['export_anonymized.ready'],
    output_path: 'export_anonymized.output',
    items_path: 'export_anonymized.output.items_json',
    description: 'Generated stage action metadata for export_anonymized.',
  },
  complete_rehydrate: {
    mode: 'rehydrate',
    target: 'export_restored',
    archetype: 'pure-compute',
    guard_paths: ['rehydrate.ready'],
    output_path: 'rehydrate.output',
    items_path: 'rehydrate.output.items_json',
    description: 'Generated stage action metadata for rehydrate.',
  },
  complete_export_restored: {
    mode: 'export_restored',
    target: 'finalize',
    archetype: 'pure-compute',
    guard_paths: ['export_restored.ready'],
    output_path: 'export_restored.output',
    items_path: 'export_restored.output.items_json',
    description: 'Generated stage action metadata for export_restored.',
  },
  complete_finalize: {
    mode: 'finalize',
    target: 'complete',
    archetype: 'pure-compute',
    guard_paths: ['finalize.ready'],
    output_path: 'finalize.output',
    items_path: 'finalize.output.items_json',
    description: 'Generated stage action metadata for finalize.',
  },
} as const;

export function registerDocumentAnonymizerTools(_registry: ToolRegistry): void {
  // Stage actions are native action_map entries. Real service adapters belong
  // behind generated external-adapter stage bodies, not extra topology actions.
  void _registry;
}
