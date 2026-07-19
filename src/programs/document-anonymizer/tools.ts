import type { ToolRegistry } from '@simodelne/pgas-server/plugin.js';

// Native stage actions are declared in specs.yml action_map. This metadata gives
// implementers one fillable local-tool slot per synthesized stage without adding
// extra invoke_tool_* actions to the engine topology.
export const stageActionTools = {
  complete_ingest: {
    mode: 'ingest',
    target: 'detect_pii',
    archetype: 'pure-compute',
    guard_paths: ['inputs.source_document_ready'],
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
    target: 'export_document',
    archetype: 'pure-compute',
    guard_paths: ['anonymize.ready'],
    output_path: 'anonymize.output',
    items_path: 'anonymize.output.items_json',
    description: 'Generated stage action metadata for anonymize.',
  },
  complete_export_document: {
    mode: 'export_document',
    target: 'complete',
    archetype: 'pure-compute',
    guard_paths: ['export_document.ready'],
    output_path: 'export_document.output',
    items_path: 'export_document.output.items_json',
    description: 'Generated stage action metadata for export_document.',
  },
} as const;

export function registerDocumentAnonymizerTools(_registry: ToolRegistry): void {
  // Stage actions are native action_map entries. Real service adapters belong
  // behind generated external-adapter stage bodies, not extra topology actions.
  void _registry;
}
