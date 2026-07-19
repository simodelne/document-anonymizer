import { describe, expect, it } from 'vitest';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

describe('document-anonymizer spec load', () => {
  it('loads the generated PGAS program entry', () => {
    const entry = createDocumentAnonymizerProgramEntry();
    expect(entry.spec.name).toBe('document-anonymizer');
    expect(entry.spec.control_plane).toBeDefined();
  });

  it('declares the internal mode-entry continuation channel', () => {
    const entry = createDocumentAnonymizerProgramEntry();

    expect(entry.spec.schannels.has('system_mode_entry')).toBe(true);
    expect(entry.spec.ingestion.get('system_mode_entry')).toEqual(['inputs.mode_entry']);
    expect(entry.spec.modes.get(entry.spec.initial)?.channels).toContain('system_mode_entry');
  });
});
