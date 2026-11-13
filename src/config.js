import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fail } from './util.js';

export const CONFIG_NAME = 'skia-motion.json';
export const DEFAULTS = { entry: 'src/index.ts', root: 'src/Root.tsx', out: 'skia-motion-out', docs: [], gl: 'angle-egl' };
export const GL_BACKENDS = ['angle-egl', 'angle', 'egl', 'swangle', 'swiftshader', 'vulkan'];

/** Walk up from `start` to find skia-motion.json. Returns its path or null. */
export const findConfig = (start) => {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, CONFIG_NAME);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
};

/**
 * Resolve the settings. Flags beat the config file, the config file beats the defaults.
 * Relative paths in the file are relative to the file; relative paths in flags to `cwd`.
 * @param {string} cwd
 * The GL backend: --gl beats SKAC_GL beats the file's `gl` beats angle-egl.
 * @param {{entry?: string, root?: string, out?: string, docs?: string[], gl?: string}} [flags]
 */
export const loadConfig = (cwd, flags = {}) => {
  const configPath = findConfig(cwd);
  let file = {};
  if (configPath) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      fail(`${configPath} is not valid JSON: ${e.message}`, 'fix the file or delete it to use the defaults');
    }
  }
  const projectDir = configPath ? dirname(configPath) : resolve(cwd);
  const abs = (p, base) => (isAbsolute(p) ? p : resolve(base, p));
  const pick = (key) => (flags[key] !== undefined ? abs(flags[key], cwd) : abs(file[key] ?? DEFAULTS[key], projectDir));
  const docs = [...(file.docs || []).map((d) => abs(d, projectDir)), ...(flags.docs || []).map((d) => abs(d, cwd))];
  const gl = flags.gl ?? process.env.SKAC_GL ?? file.gl ?? DEFAULTS.gl;
  if (!GL_BACKENDS.includes(gl)) fail(`unknown GL backend "${gl}"`, `use one of ${GL_BACKENDS.join(', ')}; swangle runs without a GPU`);
  const rules = file.rules ?? {};
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    fail(`"rules" in ${configPath} is not an object`, 'write "rules": { "skac/speed-cap": "error", "skac/no-magic-motion": "off" }');
  }
  return {
    configPath,
    projectDir,
    entry: pick('entry'),
    root: pick('root'),
    out: pick('out'),
    docs,
    gl,
    rules, // rule id -> 'error' | 'warn' | 'off', from the file; {} without one
  };
};
