import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const name = 'skia-motion-runtime';
const files = [
  'LICENSE',
  'NOTICE.md',
  'runtime/asset-draw.ts',
  'runtime/asset-image.ts',
  'runtime/asset-layout.ts',
  'runtime/asset-mesh.ts',
  'runtime/asset.ts',
  'runtime/index.ts',
  'runtime/machine-schema.d.ts',
  'runtime/machine-schema.js',
  'runtime/mobile.tsx',
  'runtime/useMachine.ts',
  'runtime/version.ts',
  'templates/motion/face.ts',
  'templates/motion/machine.ts',
  'templates/motion/motion.ts',
];

/** Pack the same TypeScript sources as the CLI runtime, with an app-only manifest. */
export function packRuntime(destination, expectedVersion) {
  const cli = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (expectedVersion !== undefined && cli.version !== expectedVersion) {
    throw new Error(`Runtime version ${cli.version} differs from the release version ${expectedVersion}`);
  }
  const target = resolve(destination);
  mkdirSync(target, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'skac-runtime-'));
  try {
    const mobile = './runtime/mobile.tsx';
    const manifest = {
      name,
      version: cli.version,
      description: 'React Native and Expo player for interactive .skmotion assets',
      type: 'module',
      main: mobile,
      types: mobile,
      exports: { '.': mobile, './machine': './runtime/index.ts' },
      license: cli.license,
      repository: cli.repository,
      homepage: cli.homepage,
      bugs: cli.bugs,
      peerDependencies: cli.peerDependencies,
      files,
    };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const file of files) {
      const destination = join(stage, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, file), destination);
    }
    const args = ['pack', stage, '--json', '--pack-destination', target];
    const npm = process.env.npm_execpath;
    const [packed] = JSON.parse(npm
      ? execFileSync(process.execPath, [npm, ...args], { encoding: 'utf8' })
      : execFileSync('npm', args, { encoding: 'utf8' }));
    return { ...packed, path: join(target, packed.filename) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Runs after semantic-release/npm has prepared package.json for this release.
export function prepare(_config, { cwd, logger, nextRelease }) {
  const destination = join(cwd, '.release');
  const packed = packRuntime(destination, nextRelease.version);
  const asset = `${name}.tgz`;
  renameSync(packed.path, join(destination, asset));
  logger.log('Packed %s (%d bytes)', asset, packed.size);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const packed = packRuntime(process.argv[2] ?? process.cwd());
  console.log(packed.path);
}
