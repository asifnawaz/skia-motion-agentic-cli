import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative } from 'node:path';
import semver from 'semver';
import { parse, specifiers } from './bundle.js';
import { DEFAULT_SKIA } from './config.js';
import { loadTypeScript } from './lint.js';
import { fail } from './util.js';

const SKIA_PACKAGES = [DEFAULT_SKIA, 'react-native-skia'];
const { peerDependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const readManifest = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return {};
    fail(`could not read ${path}: ${error.message}`, 'check the target app package.json');
  }
};

const findDeclaration = (outDir, packages) => {
  for (let dir = outDir; ; dir = dirname(dir)) {
    const app = readManifest(join(dir, 'package.json'));
    const dependencies = { ...app.devDependencies, ...app.dependencies, ...app.optionalDependencies };
    const name = packages.find((pkg) => typeof dependencies[pkg] === 'string');
    if (name) return { name, spec: dependencies[name] };
    if (dirname(dir) === dir) return {};
  }
};

// Read the installed manifest without executing React Native code or relying on package.json being exported.
const findInstalled = (outDir, packages) => {
  const require = createRequire(join(outDir, 'package.json'));
  for (const name of packages) {
    for (const path of require.resolve.paths(name) ?? []) {
      const manifest = readManifest(join(path, name, 'package.json'));
      if (typeof manifest.version === 'string') return { name, manifest };
    }
  }
  return {};
};

/** Resolve the Skia import for an export and validate the target app's version when known. */
export const appSkia = (cfg, outDir) => {
  const configured = cfg.skia ?? DEFAULT_SKIA;
  const wrapper = isAbsolute(configured);
  let specifier = configured;
  let packages = configured === 'react-native-skia' ? [configured] : SKIA_PACKAGES;
  if (wrapper) {
    const file = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']
      .map((ext) => configured + ext).find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
    if (!file) fail(`app.skia path ${configured} does not exist as a module file`, 'give the path to the Skia wrapper, relative to skia-motion.json');
    const ts = loadTypeScript(cfg);
    const dependency = specifiers(ts, parse(ts, file), { staticOnly: false }).find(({ spec }) => SKIA_PACKAGES.includes(spec));
    if (dependency) packages = [dependency.spec];
    specifier = relative(outDir, file).split('\\').join('/').replace(/\.[cm]?[jt]sx?$/, '');
    if (!specifier.startsWith('../')) specifier = `./${specifier}`;
  }

  const declared = findDeclaration(outDir, packages);
  const installed = findInstalled(outDir, declared.name ? [declared.name] : packages);
  const name = declared.name ?? installed.name ?? packages[0];
  const alias = declared.spec?.match(/^npm:(@?[^@]+)@(.+)$/);
  const upstream = [installed.manifest?.name, alias?.[1]].find((pkg) => SKIA_PACKAGES.includes(pkg)) ?? name;
  const required = peerDependencies[upstream];
  const version = installed.manifest?.version;
  const range = alias?.[2] ?? declared.spec;
  // Without an installation, a declared range is viable if it can select a supported release.
  const below = version ? !semver.satisfies(version, required) : semver.validRange(range) && !semver.intersects(range, required);
  if (below) {
    const found = version ?? declared.spec;
    fail(`${name} ${found} does not meet the required range ${required}`,
      `use ${upstream} ${required} in the target app`, { package: name, found, required });
  }

  if (configured === DEFAULT_SKIA) specifier = name;
  return {
    mapExternal: (spec) => spec === DEFAULT_SKIA || (wrapper && spec === 'react-native-skia') ? specifier : spec,
    need: `${wrapper ? cfg.skiaSpecifier : specifier} (Skia ${required})`,
  };
};
