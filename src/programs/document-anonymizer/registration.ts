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
    artifactPolicy: { rules: [{ artifactType: 'docx_export', title: 'Document Anonymizer DOCX Export', summary: 'Deterministically rendered DOCX artifact; payload bytes are base64 in domain state.', payloadRef: 'export_document.output', whenAllPaths: ['export_document.output.result_json'] }] },
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
