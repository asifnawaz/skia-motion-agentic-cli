import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { PACKAGE_ROOT } from './docs.js';
import { loadTypeScript } from './lint.js';
import { find } from './project.js';
import { bundleScene, parse, specifiers } from './bundle.js';
import { fail } from './util.js';

/** First words of the header line every exported file carries; only files with it are overwritten without --force. */
export const MARKER = '// skac export:';

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
/** Packages the exported rig and draw must not import: the app runs them on the UI thread, the video in Remotion. */
const FOREIGN = /^(react|react-native-reanimated|react-native-worklets|remotion|@remotion\/.*)$/;

const resolveFile = (fromFile, spec) => {
  const base = resolve(dirname(fromFile), spec);
  return [base, ...EXTS.map((e) => base + e)].find((p) => /\.tsx?$/.test(p) && existsSync(p)) ?? null;
};

const sourceDirs = (cfg) => [...new Set([dirname(cfg.root), join(cfg.projectDir, 'src')])];
const findSource = (cfg, file) => sourceDirs(cfg).map((d) => join(d, file)).find(existsSync);

const header = (source, version) => `${MARKER} ${source}, skia-motion-agentic-cli ${version}. Edit the source, not this copy.\n`;
const isOurs = (path) => readFileSync(path, 'utf8').startsWith(MARKER);

/**
 * Every top-level function in a file (a declaration, or a const holding a function), as [name, body or null].
 * `exportedOnly` keeps those with the `export` keyword (an engine file's public functions).
 */
const topFunctions = (ts, sf, exportedOnly = false) => {
  const out = [];
  const exported = (st) => (ts.getModifiers?.(st) || st.modifiers || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (exportedOnly && !exported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name) out.push([st.name.text, st.body ?? null]);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          out.push([d.name.text, ts.isBlock(d.initializer.body) ? d.initializer.body : null]);
        }
      }
    }
  }
  return out;
};

const startsWithWorklet = (ts, body) => {
  const first = body?.statements[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'worklet');
};

const refuseForeign = (ts, sf) => {
  const file = basename(sf.fileName);
  for (const { spec } of specifiers(ts, sf)) {
    if (FOREIGN.test(spec)) fail(`${file} imports ${spec}`, `keep ${file} free of React, Reanimated and Remotion imports; the component and the composition own those (skac docs app)`);
  }
};

/**
 * Refuse a rig or draw the app could not run on the UI thread: `entry` missing, any top-level function in the
 * file (entry or helper) without `'worklet'` as its first statement, or a React/Reanimated/Remotion import.
 */
const assertWorkletFile = (ts, sf, entry) => {
  const file = basename(sf.fileName);
  const fns = topFunctions(ts, sf);
  if (!fns.some(([n]) => n === entry)) fail(`${file} has no top-level function ${entry}`, `export function ${entry}(...) { 'worklet'; ... } (skac docs app)`);
  for (const [n, body] of fns) {
    if (!startsWithWorklet(ts, body)) {
      fail(`${n}() in ${file} does not start with 'worklet'`,
        `make 'worklet'; the first statement of ${n}() (a block body); without it the app crashes when the UI thread calls it (skac docs app)`);
    }
  }
  refuseForeign(ts, sf);
};

/** Refuse an engine file the scene copies when an exported function in it does not start with 'worklet'. */
const assertEngineWorklets = (ts, sf) => {
  const file = basename(sf.fileName);
  for (const [n, body] of topFunctions(ts, sf, true)) {
    if (!startsWithWorklet(ts, body)) {
      fail(`${n}() in motion/${file} does not start with 'worklet'`,
        `make 'worklet'; the first statement of ${n}() (a block body); the rig calls it on the UI thread, and without the directive the app crashes (skac docs app)`);
    }
  }
};

/**
 * The loader `bundleScene` calls for each relative import in the scene: the absolute path of the engine file the import
 * reaches, after refusing what a bundle may not take (a plain lib build, a file outside motion/, React or Reanimated imports,
 * an exported function without 'worklet'). Each engine file is checked once.
 */
const engineLoader = (ts) => {
  const seen = new Set();
  return (from, spec) => {
    const plain = /(?:^|\/)motion\/lib\/([^/]+?)(?:\.js|\.d\.ts)?$/.exec(spec) ?? /^\.\/lib\/([^/]+?)(?:\.js|\.d\.ts)?$/.exec(spec);
    if (plain && !plain[1].endsWith('.worklet')) {
      fail(`${basename(from)} imports ${spec}, the plain build of the lib ${plain[1]}, which the app cannot run on the UI thread`,
        `import the worklet build instead: import { morphRect } from './motion/lib/${plain[1]}.worklet' (named imports; skac update writes it from the "libs" entry in skia-motion.json)`);
    }
    const hit = resolveFile(from, spec);
    if (!hit) fail(`${basename(from)} imports ${spec}, which does not exist`, 'fix the import');
    // Engine files live in src/motion/ and, for a lib's worklet build, src/motion/lib/.
    const folder = basename(dirname(hit));
    if (folder !== 'motion' && !(folder === 'lib' && basename(dirname(dirname(hit))) === 'motion' && hit.endsWith('.worklet.ts'))) {
      fail(`${basename(from)} imports ${spec}, which is neither the scene's own rig/draw nor a file in a motion/ folder`,
        'an exported scene may import only its own rig and draw and the engine files in src/motion/ (motion.ts, face.ts)');
    }
    if (!seen.has(hit)) {
      seen.add(hit);
      const sf = parse(ts, hit);
      refuseForeign(ts, sf); // e.g. clock.app.ts or liveFace.tsx: React and Reanimated belong to the component
      assertEngineWorklets(ts, sf);
    }
    return hit;
  };
};

/** The worklet check on the bundled text: every function that must be a worklet (the scene's, and the engine functions that were exported) still starts with the directive after bundling and renaming. */
const assertBundleWorklets = (ts, text, required, name) => {
  const sf = parse(ts, `${name}.tsx`, text);
  const bodies = new Map(topFunctions(ts, sf));
  for (const n of required) {
    if (!startsWithWorklet(ts, bodies.get(n))) {
      fail(`${n}() in the bundled ${name}.tsx does not start with 'worklet'`,
        `make 'worklet'; the first statement of ${n}() (a block body); the rig calls it on the UI thread (skac docs app)`);
    }
  }
};

/**
 * `<Name> --export <dir>`: write the checked scene into an app folder as one file, <dir>/<Name>.tsx: the component, the rig, the draw and the engine declarations they reach.
 * @param {*} cfg
 * @param {string} name
 * @param {{dir?: string, force?: boolean, version: string, gate?: () => void}} opts  (gate: the draft gate, run after the file checks and before --check)
 * @param {*} deps  the blind-mode deps (what --check composes)
 * @param {Function} checkFn  blind.js `check`
 */
export const exportScene = (cfg, name, { dir, force, version, gate }, deps, checkFn) => {
  if (!dir) fail('--export needs a folder', 'like skac Pip --export src/motion');
  find(cfg, name);
  const drawAbs = findSource(cfg, `${name}.draw.ts`);
  if (!drawAbs) {
    fail(`no ${name}.draw.ts beside ${basename(cfg.root)}`,
      `only a scene whose drawing lives in src/${name}.draw.ts can be exported; scaffold one with \`skac add <Name> --draw\` (skac docs app)`);
  }
  const rigAbs = findSource(cfg, `${name}.rig.ts`);
  if (!rigAbs) fail(`no ${name}.rig.ts`, `write src/${name}.rig.ts exporting meta, rig(ms) and type Channels (skac docs app)`);

  const ts = loadTypeScript(cfg);
  const rigSf = parse(ts, rigAbs);
  const drawSf = parse(ts, drawAbs);
  assertWorkletFile(ts, rigSf, 'rig');
  assertWorkletFile(ts, drawSf, 'draw');

  if (gate) gate();
  const checked = checkFn(cfg, name, {}, deps);
  if (!checked.ok) {
    fail(`${name} does not pass --check, so it is not exported`, 'fix the failures below, then run --export again', {
      failures: checked.failures, check: `skac ${name} --check`,
    });
  }

  const tmpl = join(PACKAGE_ROOT, 'templates', 'app', 'component.tsx.tmpl');
  if (!existsSync(tmpl)) fail('templates/app/component.tsx.tmpl is missing from this package', 'reinstall skia-motion-agentic-cli');

  const component = readFileSync(tmpl, 'utf8').replaceAll('__NAME__', name);
  const compAbs = join(dirname(rigAbs), `${name}.tsx`); // the file the text stands for; it is never read from disk
  const bundled = bundleScene(ts, name, {
    rig: { abs: rigAbs, sf: rigSf }, draw: { abs: drawAbs, sf: drawSf }, component: { abs: compAbs, sf: parse(ts, compAbs, component) },
  }, engineLoader(ts));
  const outDir = resolve(process.cwd(), dir);
  const path = join(outDir, `${name}.tsx`);
  const rel = (abs) => relative(cfg.projectDir, abs);
  const sources = [...bundled.sources.filter((a) => a !== compAbs).map(rel), 'templates/app/component.tsx.tmpl'];
  const text = `${header(sources.join(', '), version)}${bundled.text}`;
  assertBundleWorklets(ts, text, bundled.required, name);

  if (existsSync(path) && !isOurs(path) && !force) {
    fail(`${path} was not written by skac export`, 'move it, export to another folder, or pass --force to overwrite');
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, text);
  return {
    ok: true, name, dir: outDir, files: [relative(outDir, path)],
    // The import is written from a file that sits beside the export folder.
    usage: [
      `import { ${name}, type ${name}Handle } from './${basename(outDir)}/${name}';`,
      `const ref = useRef<${name}Handle>(null);`,
      `<${name} ref={ref} width={200} height={200} live={motionAllowed} />`,
      `ref.current?.fire('tap');`,
    ].join('\n'),
    needs: ['@shopify/react-native-skia >= 2', 'react-native-reanimated >= 4', 'react-native-worklets (Reanimated 4 peer)'],
  };
};
