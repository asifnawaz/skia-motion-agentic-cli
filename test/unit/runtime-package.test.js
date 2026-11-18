import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { prepare } from '../../scripts/pack-runtime.js';

const cli = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('the released player installs without CLI dependencies and both app imports bundle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skac-runtime-test-'));
  try {
    const release = { cwd: directory, logger: { log() {} }, nextRelease: { version: '999.0.0' } };
    assert.throws(() => prepare({}, release), /differs from the release version/);
    prepare({}, { ...release, nextRelease: { version: cli.version } });
    const app = join(directory, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{"private":true}\n');
    const userconfig = join(directory, 'npmrc');
    writeFileSync(userconfig, '');
    const npmArgs = [
      'install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
      '--userconfig', userconfig,
      join(directory, '.release', 'skia-motion-runtime.tgz'),
    ];
    const npm = process.env.npm_execpath;
    // npm run forwards its own configuration as env variables. Use only the fixture's config.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...npmArgs] : npmArgs, { cwd: app, env });

    const readJson = (file) => JSON.parse(readFileSync(join(app, file), 'utf8'));
    const lock = readJson('package-lock.json');
    assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/skia-motion-runtime']);
    const manifest = readJson('node_modules/skia-motion-runtime/package.json');
    assert.equal(manifest.version, cli.version);
    assert.deepEqual(manifest.peerDependencies, cli.peerDependencies);
    assert.equal(manifest.bin, undefined);

    const bundled = buildSync({
      stdin: {
        contents: `
          export { MotionPlayer, loadMotionAsset, preloadMotionAsset } from 'skia-motion-runtime';
          export { useMachine, runtimeVersion } from 'skia-motion-runtime/machine';
        `,
        resolveDir: app,
      },
      jsx: 'automatic',
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      external: Object.keys(cli.peerDependencies),
      write: false,
    });
    assert.match(bundled.outputFiles[0].text, /function loadMotionAsset\(/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
