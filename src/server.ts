import { createPgasServer } from '@simodelne/pgas-server/create-server.js';
import { resolveAuthorDrivers } from './author-driver.js';
import { createDocumentAnonymizerProgramEntry } from './programs/document-anonymizer/registration.js';

// Opt-in unified native-tools author driver (PGAS_AUTHOR_DRIVER=unified).
// Default (env unset): `drivers` is undefined, no `drivers` key is passed,
// and the engine boots its legacy JSON author path exactly as before.
const drivers = resolveAuthorDrivers();

const server = await createPgasServer({
  programs: [{ name: 'document-anonymizer', entry: createDocumentAnonymizerProgramEntry() }],
  devMode: process.env.PGAS_DEV_MODE === '1',
  ...(drivers ? { drivers } : {}),
});

await server.start();
