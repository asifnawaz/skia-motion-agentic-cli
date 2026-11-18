#!/usr/bin/env node
// Type-check skac's runtime (and exported scene files) the way an app compiles them: under the app's own
// tsconfig, with the app's node_modules. TypeScript source in node_modules is checked by the app's tsc, so the
// runtime must pass the app's flags (strict, noUncheckedIndexedAccess, ...).
//   node scripts/check-app-types.js <app-dir> [exported-file...]
// Reads the app; writes the tsconfig and binding probes to a scratch folder under this package, which it removes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [app, ...exports] = process.argv.slice(2);
if (!app || !existsSync(join(app, 'tsconfig.json'))) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'give the app folder (with tsconfig.json and node_modules)', hint: 'node scripts/check-app-types.js ../my-app' }) + '\n');
  process.exit(1);
}
const appDir = resolve(app);
mkdirSync(join(PKG, '.scratch'), { recursive: true });
const dir = mkdtempSync(join(PKG, '.scratch', 'apptypes-'));
const fixture = join(PKG, 'test', 'fixtures', 'machines', 'invite.machine.json');
const bindings = join(dir, 'bindings.ts');
writeFileSync(bindings, `
import { machineRig, useMachine, type Clips, type Machine } from 'skia-motion-runtime/machine';
import json from ${JSON.stringify(fixture)};

const machine = ${readFileSync(fixture, 'utf8').trim()} as const satisfies Machine;
declare const clips: Clips;
machineRig(json, clips);
const m = useMachine(machine, clips);
m.set('live', false);
m.set('level', 0.5);
m.set('mood', 'glad');
m.setOnUI('tap', true);
m.fire('tap');
m.readOnUI('bounced');
// @ts-expect-error misspelt input
m.set('liv', true);
// @ts-expect-error out-value is read-only
m.setOnUI('bounced', true);
// @ts-expect-error an enum takes only its declared options
m.set('mood', 'wrong');
// @ts-expect-error a number input takes a number
m.set('level', false);
// @ts-expect-error a boolean input takes a boolean
m.setOnUI('live', 1);
// @ts-expect-error a trigger write takes true
m.setOnUI('tap', false);
// @ts-expect-error only triggers can fire
m.fire('live');
// @ts-expect-error misspelt output
m.readOnUI('bounce');
`);
const files = [join(PKG, 'runtime', 'index.ts'), bindings, ...exports.map((file) => resolve(file))];
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
  extends: join(appDir, 'tsconfig.json'),
  compilerOptions: {
    noEmit: true, skipLibCheck: true,
    paths: {
      'skia-motion-runtime/machine': [join(PKG, 'runtime', 'index.ts')],
      'skia-motion-agentic-cli/runtime': [join(PKG, 'runtime', 'index.ts')],
    },
    // The app's `types` resolve from its own folder; here the files import what they use, so none are loaded globally.
    types: [],
  },
  include: [],
  files,
}));
let errors = [];
try {
  const ts = createRequire(join(appDir, 'package.json'))('typescript');
  const configPath = join(dir, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, {}, configPath);
  const host = ts.createCompilerHost(parsed.options);
  const cache = ts.createModuleResolutionCache(dir, host.getCanonicalFileName, parsed.options);
  // Resolve package imports from the app so its dependencies' exports and type conditions are used.
  host.resolveModuleNameLiterals = (imports, containingFile, redirect, options, source) => imports.map((literal) => {
    const spec = literal.text;
    const from = spec.startsWith('.') || isAbsolute(spec) ? containingFile : join(appDir, 'skac-types.ts');
    const mode = ts.getModeForUsageLocation(source, literal, options);
    return ts.resolveModuleName(spec, from, options, host, cache, redirect, mode);
  });
  const diagnostics = config.error ? [config.error] : [
    ...parsed.errors,
    ...ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options, host)),
  ];
  errors = diagnostics.map((d) => ts.formatDiagnostic(d, {
    getCurrentDirectory: () => PKG,
    getCanonicalFileName: (name) => name,
    getNewLine: () => '\n',
  }).trimEnd());
} catch (e) {
  errors = [e.message];
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ok: !errors.length, app: appDir, files: files.length, errors: errors.slice(0, 40), error_count: errors.length }, null, 2) + '\n');
process.exitCode = errors.length ? 1 : 0;
