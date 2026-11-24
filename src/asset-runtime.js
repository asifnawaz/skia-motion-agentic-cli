import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { buildSync } from 'esbuild';
import { PACKAGE_ROOT } from './docs.js';

let runtime;

/** The runtime's asset code, bundled once: the CLI checks with the same parsing, layout and ink rules the app draws with. */
export function assetRuntime() {
  if (!runtime) {
    // The CLI checks its own trusted runtime bundle. Asset text goes through JSON.parse in that runtime.
    const { outputFiles } = buildSync({
      entryPoints: [join(PACKAGE_ROOT, 'runtime', 'asset-trace.ts')],
      bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18',
    });
    const module = { exports: {} };
    compileFunction(outputFiles[0].text, ['module'])(module);
    runtime = module.exports;
  }
  return runtime;
}
