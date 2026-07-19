import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@simodelne/pgas-server/testing.js';
import { createDocumentAnonymizerProgramEntry } from '../src/programs/document-anonymizer/registration.js';

describe('document-anonymizer deterministic runtime', () => {
  it('creates a deterministic PGAS test harness', async () => {
    const harness = await createTestHarness(createDocumentAnonymizerProgramEntry(), {
      programName: 'document-anonymizer',
      defaultChannel: 'user_text',
    });

    expect(harness).toBeDefined();
  });
});
