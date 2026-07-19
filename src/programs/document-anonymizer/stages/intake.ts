import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const domain = input.domain as Record<string, unknown>;
  const chars = typeof domain['inputs.source_document.char_count'] === 'number' ? (domain['inputs.source_document.char_count'] as number) : 0;
  const result = { stage: input.stage, ready: true, char_count: chars, summary: input.stage + ' complete' };
  return { result_json: JSON.stringify(result), items_json: JSON.stringify([input.stage + ':ready']), digest: '' };
}
