import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const domain = input.domain as Record<string, unknown>;
  const anonText = typeof domain['inputs.source_document.full_text'] === 'string' ? (domain['inputs.source_document.full_text'] as string) : '';
  const format = typeof domain['inputs.source_document.extraction_kind'] === 'string' ? (domain['inputs.source_document.extraction_kind'] as string) : 'txt';
  const request = typeof domain['inputs.initial_user_text'] === 'string' ? (domain['inputs.initial_user_text'] as string) : (typeof domain['inputs.user_text'] === 'string' ? (domain['inputs.user_text'] as string) : '');
  let mapping: Array<{ token: string; original: string }> = [];
  const match = request.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) { mapping = (parsed as Array<Record<string, unknown>>).filter((x) => x && typeof x['token'] === 'string' && typeof x['original'] === 'string').map((x) => ({ token: x['token'] as string, original: x['original'] as string })); }
    } catch (parseError) { void parseError; }
  }
  const longestFirst = [...mapping].sort((a, b) => b.token.length - a.token.length);
  let restored = anonText;
  for (const m of longestFirst) restored = restored.split(m.token).join(m.original);
  const result = { stage: input.stage, output_text: restored, format, restored_count: mapping.length };
  return { result_json: JSON.stringify(result), items_json: JSON.stringify(mapping.length > 0 ? mapping.map((m) => 'restored:' + m.token) : ['restored:none']), digest: '' };
}
