// Typecheck the runtime the way an Expo app does: pack it, install the tarball beside pinned host
// packages in test/typecheck, and run strict tsc (Expo's base options plus strict and
// noUncheckedIndexedAccess) over a file that imports every entry point.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRuntime } from './pack-runtime.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = join(root, 'test/typecheck');
const stage = mkdtempSync(join(tmpdir(), 'skac-typecheck-'));
const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--no-package-lock'];
// Under npm run, the parent's settings arrive as npm_config_* variables, and a project-scoped
// allow-scripts setting makes the nested install refuse to run. The install runs no scripts anyway.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)));
const npm = (args) => execFileSync('npm', args, { cwd: host, stdio: 'inherit', env });
try {
  const { path } = packRuntime(stage);
  npm(['install', ...flags]);
  // npm keeps an installed tarball of the same version, which would check stale sources.
  rmSync(join(host, 'node_modules/skia-motion-runtime'), { recursive: true, force: true });
  npm(['install', ...flags, '--no-save', path]);
  execFileSync(join(host, 'node_modules/.bin/tsc'), ['-p', host], { stdio: 'inherit' });
  console.log('Runtime typechecks under strict host settings.');
} catch (error) {
  if (error.status === undefined) throw error;
  process.exitCode = 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
