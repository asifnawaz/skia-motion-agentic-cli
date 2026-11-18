// The libs file the e2e tests give the CLI (SKAC_LIBS_FILE): onetake comes from a local fixture, so `create` never fetches.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'onetake-offline.js');

export const offlineLibsFile = (dir) => {
  const path = join(dir, 'libs.json');
  writeFileSync(path, JSON.stringify({ onetake: FIXTURE }));
  return path;
};
