import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { appSkia } from './app-skia.js';
import { PACKAGE_ROOT } from './docs.js';
import { loadTypeScript } from './lint.js';
import { clipsFile, loadClips, machineFile, readMachine, validateMachine } from './machine.js';
import { find } from './project.js';
import { bundleModule, findRigFile } from './rig.js';
import { bundleScene, parse, specifiers } from './bundle.js';
import { managedFileCheck } from './update.js';
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
  const scene = find(cfg, name);
  const outDir = resolve(process.cwd(), dir);
  const skia = appSkia(cfg, outDir);
  const mfile = machineFile(cfg, name);
  if (mfile) return exportMachine(cfg, name, { outDir, skia, force, version, mfile, gate, scene }, deps, checkFn);
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
  }, engineLoader(ts), { mapExternal: skia.mapExternal });
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
    needs: [skia.need, 'react-native-reanimated >= 4', 'react-native-worklets (Reanimated 4 peer)'],
    ...(skia.warning && { warnings: [skia.warning] }),
  };
};

// ---- machine scenes ----------------------------------------------------------------------------------------------

/** Engine files the runtime package carries: an exported machine scene imports them from it instead of copying them. */
const IN_RUNTIME = new Set(['motion.ts', 'face.ts', 'machine.ts']);
export const RUNTIME_MODULE = 'skia-motion-agentic-cli/runtime';
const isRuntimeEngine = (abs) => basename(dirname(abs)) === 'motion' && IN_RUNTIME.has(basename(abs));
const isLocal = (spec) => spec.startsWith('.') || isAbsolute(spec);
const machineEntries = (cfg, name) => [clipsFile(cfg, name), findSource(cfg, `${name}.draw.ts`)];
const RESERVED = new Set(['machine', 'exportedBy']);

/** Follow the rig, clips and draw imports, including the imports inside the engine files replaced by the runtime. */
const assertCurrentEngine = (ts, cfg, entries) => {
  const check = managedFileCheck(cfg.projectDir);
  const seen = new Set();
  const visit = (abs, sf) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    if (isRuntimeEngine(abs)) {
      const path = relative(cfg.projectDir, abs).split('\\').join('/');
      const state = check(path);
      if (state !== 'same') {
        const hint = state === 'kept-edited' ? 'run `skac update --force` to replace the edited engine file'
          : state === 'unmanaged' ? 'run `skac update` and import the engine from src/motion/' : 'run `skac update`';
        fail(`${path} is not current (${state}), so the app would run other code than --check did`, hint);
      }
    }
    for (const { spec } of specifiers(ts, sf ?? parse(ts, abs))) {
      if (!isLocal(spec)) continue;
      const target = resolve(dirname(abs), spec);
      const hit = resolveFile(abs, spec)
        ?? ts.resolveModuleName(spec, abs, { allowJs: true }, ts.sys).resolvedModule?.resolvedFileName;
      const engine = /\.[jt]s$/.test(target) ? target.replace(/\.js$/, '.ts') : `${target}.ts`;
      if (hit && !/\.d\.[cm]?ts$/.test(hit) && /\.[cm]?[jt]sx?$/.test(hit)) visit(hit);
      else if (isRuntimeEngine(engine)) visit(engine);
    }
  };
  for (const { abs, sf } of entries) visit(abs, sf);
};

/** Every `play` method of the `clips` object (or any object in the file) must start with 'worklet'. */
const assertClipWorklets = (ts, sf) => {
  const file = basename(sf.fileName);
  const visit = (node) => {
    const isPlay = (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node))
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'play';
    if (isPlay) {
      const fn = ts.isMethodDeclaration(node) ? node : node.initializer;
      const body = fn && (ts.isMethodDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body && ts.isBlock(fn.body) ? fn.body : null;
      if (!startsWithWorklet(ts, body)) {
        fail(`a clip's play() in ${file} does not start with 'worklet'`, "write play(ms) { 'worklet'; ... } with a block body: the app runs it on the UI thread (skac docs machine)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
};

/** The clips, draw and transitive helpers to inline. Runtime imports are recorded but their files stay external. */
const gatherMachine = (ts, entries) => {
  const modules = new Map();
  const visit = (abs) => {
    if (modules.has(abs)) return;
    const sf = parse(ts, abs);
    const imports = new Map();
    modules.set(abs, { abs, sf, imports });
    for (const { spec } of specifiers(ts, sf, { staticOnly: false })) {
      if (!isLocal(spec)) continue;
      const hit = resolveFile(abs, spec);
      imports.set(spec, hit);
      if (hit && !isRuntimeEngine(hit)) visit(hit);
    }
  };
  for (const abs of entries) if (abs) visit(abs);
  return modules;
};

/** Machine sources covered by the draft gate, in addition to the CLI rig. Null for a plain rig. */
export const machineSourceFiles = (cfg, name) => {
  const machine = machineFile(cfg, name);
  if (!machine) return null;
  const modules = gatherMachine(loadTypeScript(cfg), machineEntries(cfg, name));
  return [machine, ...modules.keys()].sort();
};

/** A helper module a machine scene imports: worklet functions only, no React, Reanimated or Remotion. */
const assertHelper = (ts, sf) => {
  for (const [n, body] of topFunctions(ts, sf)) {
    if (!startsWithWorklet(ts, body)) {
      fail(`${n}() in ${basename(sf.fileName)} does not start with 'worklet'`,
        `the exported scene imports ${basename(sf.fileName)}, so the app runs it on the UI thread: make 'worklet'; the first statement of ${n}()`);
    }
  }
  refuseForeign(ts, sf);
};

/** `--export` for a machine scene collects the machine, clips and drawing in one file that imports the app runtime. */
const exportMachine = (cfg, name, { outDir, skia, force, version, mfile, gate, scene }, deps, checkFn) => {
  const [clipsAbs, drawAbs] = machineEntries(cfg, name);
  if (!drawAbs) fail(`no ${name}.draw.ts`, `a machine scene draws in src/${name}.draw.ts: draw(canvas, channels, size) (skac docs machine)`);
  if (!clipsAbs) fail(`no ${name}.clips.ts`, `export const clips = { idle: { ms, play(ms) { 'worklet'; ... } } } from src/${name}.clips.ts (skac docs machine)`);
  const ts = loadTypeScript(cfg);
  const modules = gatherMachine(ts, [clipsAbs, drawAbs]);
  const clips = modules.get(clipsAbs);
  const draw = modules.get(drawAbs);
  const rigAbs = findRigFile(cfg, name, scene._abs);
  assertCurrentEngine(ts, cfg, [{ abs: rigAbs }, draw, clips]);
  const m = readMachine(mfile);
  const sourceClips = loadClips(cfg, name).clips;
  const judged = validateMachine(m, { clips: sourceClips });
  if (judged.problems.length) {
    fail(`${name}.machine.json does not pass --machine, so it is not exported`, judged.problems[0].hint, { problems: judged.problems, check: `skac ${name} --machine` });
  }
  assertWorkletFile(ts, draw.sf, 'draw');
  for (const helper of modules.values()) if (helper !== draw) assertHelper(ts, helper.sf);
  assertClipWorklets(ts, clips.sf);

  if (gate) gate();
  // Keep the authored check metadata, but replay the machine and clips the app will actually use.
  const checked = checkFn(cfg, name, { rigFor: (meta) => {
    const engine = bundleModule(cfg, join(PACKAGE_ROOT, 'templates', 'motion', 'machine.ts'), 'skac-machine-core.cjs');
    return engine.machineRig(m, sourceClips, meta.events);
  } }, deps);
  if (!checked.ok) {
    fail(`${name} does not pass --check, so it is not exported`, 'fix the failures below, then run --export again', {
      failures: checked.failures, check: `skac ${name} --check`,
    });
  }
  const tmpl = join(PACKAGE_ROOT, 'templates', 'app', 'machine-component.tsx.tmpl');
  if (!existsSync(tmpl)) fail('templates/app/machine-component.tsx.tmpl is missing from this package', 'reinstall skia-motion-agentic-cli');

  const tokens = { __NAME__: name, __EXPORTED_BY__: JSON.stringify(version), __MACHINE__: JSON.stringify(m, null, 2) };
  const component = readFileSync(tmpl, 'utf8').replace(/__NAME__|__EXPORTED_BY__|__MACHINE__/g, (token) => tokens[token]);
  const compAbs = join(dirname(drawAbs), `${name}.tsx`);
  const loadLocal = (from, spec) => {
    const hit = modules.get(from)?.imports.get(spec);
    if (hit === rigAbs) {
      fail(`${basename(from)} imports ${spec}`, `a machine scene's draw and clips stand without the rig bridge: type channels as Pose['channels'] from ./motion/machine (skac docs machine)`);
    }
    if (!hit) fail(`${basename(from)} imports ${spec}, which does not exist`, 'fix the import');
    return isRuntimeEngine(hit) ? { external: RUNTIME_MODULE, file: basename(hit) } : modules.get(hit);
  };
  const bundled = bundleScene(ts, name, { clips, draw, component: { abs: compAbs, sf: parse(ts, compAbs, component) } }, loadLocal, {
    reserved: RESERVED,
    mapExternal: skia.mapExternal,
  });
  const sources = [mfile, ...bundled.sources.filter((a) => a !== compAbs)].map((a) => relative(cfg.projectDir, a));
  sources.push('templates/app/machine-component.tsx.tmpl');
  const text = `${header(sources.join(', '), version)}${bundled.text}`;
  assertBundleWorklets(ts, text, bundled.required, name);

  const path = join(outDir, `${name}.tsx`);
  if (existsSync(path) && !isOurs(path) && !force) {
    fail(`${path} was not written by skac export`, 'move it, export to another folder, or pass --force to overwrite');
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, text);
  return {
    ok: true, name, dir: outDir, machine: true, files: [basename(path)],
    usage: [
      `import { ${name}, type ${name}Handle } from './${basename(outDir)}/${name}';`,
      `const ref = useRef<${name}Handle>(null);`,
      `<${name} ref={ref} width={200} height={200} live={visible} />`,
      `ref.current?.set('<value>', true);`,
    ].join('\n'),
    needs: [`skia-motion-agentic-cli@${version} (the runtime)`, skia.need, 'react-native-reanimated >= 4', 'react-native-worklets (Reanimated 4 peer)'],
    ...(skia.warning && { warnings: [skia.warning] }),
  };
};
