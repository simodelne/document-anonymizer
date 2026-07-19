import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const domain = input.domain as Record<string, unknown>;
  const fullText = typeof domain['inputs.source_document.full_text'] === 'string'
    ? (domain['inputs.source_document.full_text'] as string)
    : '';
  const format = typeof domain['inputs.source_document.extraction_kind'] === 'string'
    ? (domain['inputs.source_document.extraction_kind'] as string)
    : 'txt';
  let entities: Array<{ text: string; type: string }> = [];
  const typed = domain['detect_pii.result.entities'];
  if (Array.isArray(typed)) {
    entities = typed as Array<{ text: string; type: string }>;
  } else {
    const raw = domain['detect_pii.result_json'];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(parsed['entities'])) entities = parsed['entities'] as Array<{ text: string; type: string }>;
      } catch (parseError) {
        void parseError;
      }
    }
  }
  const uniqueOrdered: Array<{ text: string; type: string }> = [];
  const seen = new Set<string>();
  for (const e of entities) {
    const t = typeof e?.text === 'string' ? e.text : '';
    const ty = (typeof e?.type === 'string' ? e.type : 'ENTITY').toUpperCase();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    uniqueOrdered.push({ text: t, type: ty });
  }
  const counters: Record<string, number> = {};
  const assigned = new Map<string, { token: string; type: string; occurrences: number }>();
  for (const e of uniqueOrdered) {
    counters[e.type] = (counters[e.type] ?? 0) + 1;
    assigned.set(e.text, { token: '[' + e.type + '_' + String(counters[e.type]) + ']', type: e.type, occurrences: 0 });
  }
  const longestFirst = [...uniqueOrdered].sort((a, b) => b.text.length - a.text.length);
  let output = fullText;
  for (const e of longestFirst) {
    const rec = assigned.get(e.text);
    if (!rec) continue;
    const parts = output.split(e.text);
    rec.occurrences = parts.length - 1;
    output = parts.join(rec.token);
  }
  const mapping: Array<{ token: string; original: string; type: string; occurrences: number }> = [];
  for (const e of uniqueOrdered) {
    const rec = assigned.get(e.text);
    if (rec) mapping.push({ token: rec.token, original: e.text, type: rec.type, occurrences: rec.occurrences });
  }
  const result = { stage: input.stage, output_text: output, format, mapping, entity_count: mapping.length };
  const items_json = JSON.stringify(mapping.length > 0 ? mapping.map((m) => 'token:' + m.token) : ['token:none']);
  return { result_json: JSON.stringify(result), items_json, digest: '' };
}
