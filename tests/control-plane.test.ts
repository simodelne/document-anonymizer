import { describe, expect, it } from 'vitest';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

describe('document-anonymizer control plane', () => {
  it('declares REPL controls including session lifecycle commands', () => {
    const entry = createDocumentAnonymizerProgramEntry();
    const controls = entry.spec.control_plane?.controls as Map<string, {
      aliases?: string[];
      presentation?: { confirm?: boolean };
    }> | undefined;

    expect(Array.from(controls?.keys() ?? [])).toEqual(expect.arrayContaining(['ask', 'abort', 'new', 'history', 'status', 'resume', 'help']));
    expect(controls?.get('abort')?.presentation?.confirm).toBe(true);
    expect(controls?.get('new')?.aliases).toContain('/new');
    expect(controls?.get('abort')?.aliases).toContain('/abort');
  });
});
