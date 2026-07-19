import type { StageInput, StageOutput, StageRuntime } from '../contracts.js';
import { renderStructuredDocxDocument } from '../export/docx.js';

declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: 'base64'): string };
};

export async function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
  void runtime;
  const sections = sectionsFromDomain(input.domain, input.stage);
  const bytes = renderStructuredDocxDocument({
    title: 'Document Anonymizer DOCX Export',
    sections,
  });
  const sha256 = await sha256Hex(bytes);
  const result = {
    stage: input.stage,
    docx_base64: Buffer.from(bytes).toString('base64'),
    docx_bytes: bytes.length,
    sha256,
    section_count: sections.length,
  };
  return {
    result_json: JSON.stringify(result),
    items_json: JSON.stringify(['docx_export:' + result.sha256]),
    digest: '',
  };
}

interface ExportSection {
  title: string;
  body: string | string[];
}

function sectionsFromDomain(domain: Record<string, unknown>, stage: string): ExportSection[] {
  const sections: ExportSection[] = [];
  for (const key of Object.keys(domain).sort()) {
    if (key.startsWith(stage + '.')) {
      continue;
    }
    const value = domain[key];
    const section = sectionForDomainValue(key, value);
    if (section) {
      sections.push(section);
    }
  }
  return sections.length > 0
    ? sections
    : [{ title: humanizePath('export_restored'), body: 'No accumulated domain state was available for export.' }];
}

function sectionForDomainValue(path: string, value: unknown): ExportSection | undefined {
  if (isStageOutput(value)) {
    const parsed = parseJsonValue(value.result_json);
    return {
      title: humanizePath(path),
      body: stableStringify(parsed ?? { result_json: value.result_json }),
    };
  }
  if (path.endsWith('.result_json') && typeof value === 'string') {
    const parsed = parseJsonValue(value);
    return {
      title: humanizePath(path),
      body: stableStringify(parsed ?? value),
    };
  }
  if (path.startsWith('work.') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    return {
      title: humanizePath(path),
      body: String(value),
    };
  }
  return undefined;
}

function isStageOutput(value: unknown): value is { result_json: string; items_json?: string; digest?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { result_json?: unknown }).result_json === 'string';
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(', ') + ']';
  }
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ': ' + stableStringify(record[key])).join(', ') + '}';
}

function humanizePath(path: string): string {
  const words = path
    .replace(/\.output(?:\.result_json)?$/u, '')
    .replace(/\.result_json$/u, '')
    .split(/[._-]+/u)
    .filter(Boolean);
  const label = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(' ');
  return label.length > 0 ? label : 'Program State';
}

function toParagraphs(body: string | string[]): string[] {
  return Array.isArray(body) ? body : body.split(/\n+/u);
}


async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

