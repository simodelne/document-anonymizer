import {
  createProgramAdapters,
  createToolRegistry,
  loadSpecWithPatterns,
  type ProgramEntry,
} from '@simodelne/pgas-server/plugin.js';
import { handlers, reactionHandlers } from './handlers.js';
import { registerDocumentAnonymizerTools } from './tools.js';

export function createDocumentAnonymizerProgramEntry(): ProgramEntry {
  const specPath = decodeURIComponent(new URL('./specs.yml', import.meta.url).pathname);
  const { spec } = loadSpecWithPatterns(specPath);
  const toolRegistry = createToolRegistry();
  registerDocumentAnonymizerTools(toolRegistry);

  return {
    spec,
    reactionHandlers,
    artifactPolicy: { rules: [{ artifactType: 'anonymization_mapping', title: 'Anonymization Mapping', summary: 'Reversible token-to-original mapping plus anonymized text as JSON in domain state; enables rebuilding the original document.', payloadRef: 'anonymize.output', whenAllPaths: ['anonymize.output.result_json'] }, { artifactType: 'docx_export', title: 'Document Anonymizer DOCX Export', summary: 'Deterministically rendered DOCX artifact; payload bytes are base64 in domain state.', payloadRef: 'export_anonymized.output', whenAllPaths: ['export_anonymized.output.result_json'] }, { artifactType: 'docx_export', title: 'Document Anonymizer DOCX Export', summary: 'Deterministically rendered DOCX artifact; payload bytes are base64 in domain state.', payloadRef: 'export_restored.output', whenAllPaths: ['export_restored.output.result_json'] }] },
    createAdapters: (ctx) => {
      const adapters = createProgramAdapters(spec, ctx, handlers);
      if (spec.tools) {
        for (const [name, decl] of spec.tools) {
          if (toolRegistry.has(name)) {
            adapters.outputs.set(decl.channelId, toolRegistry.createAdapter(name));
          }
        }
      }
      return adapters;
    },
  };
}
