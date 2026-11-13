import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { PACKAGE_ROOT } from './docs.js';
import { loadTypeScript } from './lint.js';
import { find } from './project.js';
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

const parse = (ts, abs) => ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true,
  abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * Every module specifier in a file, read with TypeScript's parser: `import ... from`, side-effect `import '…'`,
 * `import type`, `export ... from` and `export * from`. A relative `import()`, `require()` or `import('…').T`
 * is refused, because the copy could not follow it.
 */
const specifiers = (ts, sf) => {
  const out = [];
  const refuse = (node, spec) => fail(`${basename(sf.fileName)} loads ${spec} at run time or through an import type`,
    'use a static import at the top of the file, so --export can copy and rewrite it');
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const lit = node.moduleSpecifier;
      out.push({ spec: lit.text, start: lit.getStart(sf) + 1, end: lit.getEnd() - 1 });
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0].text.startsWith('.')) {
      refuse(node, node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
      && node.argument.literal.text.startsWith('.')) {
      refuse(node, node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

/** Every top-level function in a file (a declaration, or a const holding a function), as [name, body or null]. */
const topFunctions = (ts, sf) => {
  const out = [];
  for (const st of sf.statements) {
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

/**
 * Collect the engine files (a `motion` folder in the project) that the scene's files import, with the
 * rewritten text of the scene's own files. Engine files land flat in <Name>/motion/, so an import of
 * `./motion/motion` stays `./motion/motion` and one of `./face` inside the engine stays `./face`.
 */
const gather = (ts, name, own) => {
  const engine = new Map(); // abs source -> { rel: 'motion/<base>', text }
  const toEngine = (from, spec) => {
    const hit = resolveFile(from, spec);
    if (!hit) fail(`${basename(from)} imports ${spec}, which does not exist`, 'fix the import');
    if (basename(dirname(hit)) !== 'motion') {
      fail(`${basename(from)} imports ${spec}, which is neither the scene's own rig/draw nor a file in a motion/ folder`,
        'an exported scene may import only its own rig and draw and the engine files in src/motion/ (motion.ts, face.ts)');
    }
    if (!engine.has(hit)) {
      const sf = parse(ts, hit);
      refuseForeign(ts, sf); // e.g. clock.app.ts or liveFace.tsx: React and Reanimated belong to the component
      engine.set(hit, { rel: `motion/${basename(hit)}`, text: sf.getFullText() });
      for (const { spec: s } of specifiers(ts, sf)) if (s.startsWith('.')) toEngine(hit, s);
    }
    return `./${engine.get(hit).rel.replace(/\.tsx?$/, '')}`;
  };
  const rewritten = {};
  for (const [file, { abs, sf }] of Object.entries(own)) {
    let text = sf.getFullText();
    // Splice from the end so earlier offsets stay valid.
    for (const s of specifiers(ts, sf).reverse()) {
      if (!s.spec.startsWith('.') || s.spec === `./${name}.rig` || s.spec === `./${name}.draw`) continue;
      text = text.slice(0, s.start) + toEngine(abs, s.spec) + text.slice(s.end);
    }
    rewritten[file] = text;
  }
  return { rewritten, engine };
};

/**
 * `<Name> --export <dir>`: write the checked rig and drawing into an app folder as a component the app mounts.
 * @param {*} cfg
 * @param {string} name
 * @param {{dir?: string, force?: boolean, version: string}} opts
 * @param {*} deps  the blind-mode deps (what --check composes)
 * @param {Function} checkFn  blind.js `check`
 */
export const exportScene = (cfg, name, { dir, force, version }, deps, checkFn) => {
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

  const checked = checkFn(cfg, name, {}, deps);
  if (!checked.ok) {
    fail(`${name} does not pass --check, so it is not exported`, 'fix the failures below, then run --export again', {
      failures: checked.failures, check: `skac ${name} --check`,
    });
  }

  const tmpl = join(PACKAGE_ROOT, 'templates', 'app', 'component.tsx.tmpl');
  if (!existsSync(tmpl)) fail('templates/app/component.tsx.tmpl is missing from this package', 'reinstall skia-motion-agentic-cli');

  const { rewritten, engine } = gather(ts, name, {
    [`${name}.rig.ts`]: { abs: rigAbs, sf: rigSf }, [`${name}.draw.ts`]: { abs: drawAbs, sf: drawSf },
  });
  const outDir = resolve(process.cwd(), dir);
  const out = join(outDir, name);
  const rel = (abs) => relative(cfg.projectDir, abs);
  const files = [
    { path: join(out, `${name}.rig.ts`), text: header(rel(rigAbs), version) + rewritten[`${name}.rig.ts`] },
    { path: join(out, `${name}.draw.ts`), text: header(rel(drawAbs), version) + rewritten[`${name}.draw.ts`] },
    { path: join(out, 'index.tsx'), text: header(`templates/app/component.tsx.tmpl`, version) + readFileSync(tmpl, 'utf8').replaceAll('__NAME__', name) },
    ...[...engine.entries()].map(([abs, e]) => ({ path: join(out, e.rel), text: header(rel(abs), version) + e.text })),
  ];

  const blocked = files.filter((f) => existsSync(f.path) && !isOurs(f.path));
  if (blocked.length && !force) {
    fail(`${blocked.length} file(s) in ${out} were not written by skac export: ${blocked.map((f) => relative(out, f.path)).join(', ')}`,
      'move them, export to another folder, or pass --force to overwrite');
  }
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.text);
  }
  return {
    ok: true, name, dir: out, files: files.map((f) => relative(outDir, f.path)),
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
