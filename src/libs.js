// A project's motion libraries: a name and a path in skia-motion.json ("libs"), copied into src/motion/lib/ as the
// plain file, a loose typing, and a generated worklet build the app can run on the UI thread.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { PACKAGE_ROOT } from './docs.js';
import { fail } from './util.js';

const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** What the worklet build leaves out, by export name: each returns a stateful object or builds a buffer a worklet cannot carry. */
export const LEFT_OUT = {
  sim: 'integrates once at 240 Hz and returns objects holding their own state',
  silk: 'builds a pixel buffer and hangs data on itself',
  carouselLoop: 'integrates once into typed arrays and returns a closure over them',
  lattice: 'returns a grid description meant for a canvas loop, not a number a rig reads',
};
/** Names a worklet cannot reach: browser or module-loader globals. */
const HOST_ONLY = new Set(['root', 'module', 'window', 'document', 'require', 'exports', 'globalThis']);

export const expandHome = (p, home = homedir()) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p);

/** The user's default libs (`~/.config/skac/libs.json`, or the file SKAC_LIBS_FILE names; same shape as the project's "libs"), or {}. */
export const userLibsFile = (home = homedir()) => process.env.SKAC_LIBS_FILE || join(home, '.config', 'skac', 'libs.json');
export const readUserLibs = (home = homedir()) => {
  const p = userLibsFile(home);
  if (!existsSync(p)) return {};
  const text = readFileSync(p, 'utf8');
  if (!text.trim()) return {}; // an empty file (SKAC_LIBS_FILE=/dev/null) means no default libs
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(`${p} is not valid JSON: ${e.message}`, 'write { "<name>": "<path to the lib>" } or delete the file');
  }
  checkShape(raw, p);
  return raw;
};

const checkShape = (raw, where) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`"libs" in ${where} is not an object`, 'write "libs": { "onetake": "~/.claude/skills/onetake/lib/motion.js" }');
  }
  for (const [name, p] of Object.entries(raw)) {
    if (!NAME.test(name)) fail(`lib name ${JSON.stringify(name)} in ${where} is not a plain name`, 'use letters, digits, - and _, starting with a letter');
    if (typeof p !== 'string' || !p) fail(`lib ${name} in ${where} has no path`, `write "${name}": "<path to the lib's .js file>"`);
  }
};

/** Resolve a { name: path } map to absolute paths: `~` expanded, relative paths taken from `base`. */
export const resolveLibs = (raw, base, where = 'skia-motion.json', home = homedir()) => {
  if (raw === undefined) return {};
  checkShape(raw, where);
  return Object.fromEntries(Object.entries(raw).map(([n, p]) => {
    const e = expandHome(p, home);
    return [n, isAbsolute(e) ? e : resolve(base, e)];
  }));
};

/**
 * The libraries skac carries, by name: where they come from and what bytes they must be. `skac create` and `skac update` fetch
 * the files over https from raw.githubusercontent.com at this commit and refuse a file whose sha256 differs. Moving to a newer
 * onetake is this one table: the commit and the two hashes (the golden test in test/unit/libs.test.js checks the new file).
 * The first file is the lib itself (written to src/motion/lib/<name>.js), the second its licence (<name>.LICENSE).
 */
export const BUILTIN_LIBS = {
  onetake: {
    repo: 'feitangyuan/onetake',
    commit: 'abb6d17279cdc749e27e99aa534a062d8fd01ced',
    files: {
      'lib/motion.js': '64697ab4df78496ea95999135fe098a9b24bff10d687273fbec193b6cfd1d27e',
      LICENSE: '1f7a4f2449fb543769568a4f0e6e2c622bf28e841fde09a4b6819dcaa4567412',
    },
  },
};
const FETCH_TIMEOUT_MS = 30000;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const rawUrl = (entry, path) => `https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${path}`;

/** Project paths a lib owns, relative to the project: the copy, its typing and the worklet build, and (a fetched lib) its licence. */
export const libPaths = (name, withLicense = false) => [
  `src/motion/lib/${name}.js`, `src/motion/lib/${name}.d.ts`, `src/motion/lib/${name}.worklet.ts`,
  ...(withLicense ? [`src/motion/lib/${name}.LICENSE`] : []),
];

/** The offline route, named in every fetch error. */
export const overrideHint = (name) => `offline: write "libs": { "${name}": "<path to ${name}'s ${Object.keys(BUILTIN_LIBS[name]?.files ?? { 'lib/motion.js': 1 })[0]}>" } in skia-motion.json or ${userLibsFile()}; a local path needs no network`;

/** One https GET with Node's global fetch, run in a child process because skac is synchronous. Returns the body as a Buffer. */
export const fetchSync = (url) => {
  const code = 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) { console.error("HTTP " + r.status); process.exit(2); } '
    + 'process.stdout.write(Buffer.from(await r.arrayBuffer())); }).catch((e) => { console.error(e.cause?.code || e.message); process.exit(1); });';
  const r = spawnSync(process.execPath, ['-e', code, url], { maxBuffer: 1 << 26, timeout: FETCH_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    const why = (r.error?.message || r.stderr?.toString().trim() || `exit ${r.status}`);
    const name = Object.keys(BUILTIN_LIBS).find((n) => url.includes(`/${BUILTIN_LIBS[n].repo}/`)) ?? 'onetake';
    fail(`could not fetch ${url} (${why})`, overrideHint(name));
  }
  return r.stdout;
};

const skacVersion = () => JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/** The lib's `Required Notice:` line: in the file itself, else in a LICENSE beside it or one folder up. */
const requiredNotice = (srcPath, text) => {
  const find = (s) => /^.*Required Notice:.*$/m.exec(s)?.[0].replace(/^[\s*/>#-]*/, '') ?? null;
  const own = find(text);
  if (own) return own;
  for (const d of [dirname(srcPath), dirname(dirname(srcPath))]) {
    const lic = join(d, 'LICENSE');
    if (existsSync(lic)) {
      const l = find(readFileSync(lic, 'utf8'));
      if (l) return l;
    }
  }
  return null;
};

// ---- the worklet build ---------------------------------------------------------------------------------------

const isFn = (ts, n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** Identifiers a node reads or calls by name: not property names, so `a.spring` and `{ spring: sp }` do not count as `spring`. */
const referenced = (ts, node) => {
  const out = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const label = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isBindingElement(p) && p.propertyName === n) || (ts.isMethodDeclaration(p) && p.name === n));
      if (!label) out.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
};

/** Insertions that give every function in `node` `'worklet'` as its first statement (expression bodies become blocks). */
const workletEdits = (ts, sf, node) => {
  const edits = [];
  const visit = (n) => {
    if (isFn(ts, n) && n.body) {
      if (ts.isBlock(n.body)) edits.push({ pos: n.body.getStart(sf) + 1, text: " 'worklet';" });
      else {
        edits.push({ pos: n.body.getStart(sf), text: "{ 'worklet'; return " });
        edits.push({ pos: n.body.getEnd(), text: '; }' });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return edits;
};

const splice = (text, offset, edits) => {
  const list = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.pos - a.pos || b.i - a.i);
  let out = text;
  for (const e of list) out = out.slice(0, e.pos - offset) + e.text + out.slice(e.pos - offset);
  return out;
};

/**
 * Unwrap an IIFE library (`(function (root) { ...; const OM = {...}; ... })(...)`) into an ES module with the TypeScript API:
 * every function gets 'worklet', each OM key is a named export, and what a worklet cannot carry is left out and listed in the header.
 * @returns {{code: string, exports: string[], leftOut: {name: string, why: string}[]}}
 */
export const buildWorklet = (ts, source, { name, srcName = `${name}.js`, notice = null, version = skacVersion() } = {}) => {
  const sf = ts.createSourceFile(srcName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const call = sf.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
    && ts.isParenthesizedExpression(s.expression.expression) && ts.isFunctionExpression(s.expression.expression.expression));
  if (!call) {
    fail(`${srcName} is not a library wrapped in one function call`, 'a lib has the shape (function (root) { ...; const OM = { ... }; ...; })(globalThis); skac cannot unwrap another shape');
  }
  const body = call.expression.expression.expression.body;

  // Top-level declarations of the IIFE body, by name.
  const decls = new Map();
  for (const st of body.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) decls.set(st.name.text, { st, mutable: false });
    else if (ts.isVariableStatement(st)) {
      const list = st.declarationList.declarations;
      if (list.length !== 1 || !ts.isIdentifier(list[0].name)) {
        fail(`${srcName} declares several names in one statement (${st.getText(sf).slice(0, 40)}...)`, 'write one const or let per name, so each can be a named export');
      }
      decls.set(list[0].name.text, { st, mutable: !(st.declarationList.flags & ts.NodeFlags.Const) });
    }
  }
  const omDecl = decls.get('OM');
  const om = omDecl?.st.declarationList.declarations[0].initializer;
  if (!om || !ts.isObjectLiteralExpression(om)) fail(`${srcName} has no const OM = { ... } object`, 'the lib must collect its moves in one OM object literal');

  // OM keys: a shorthand name of a top-level declaration, or a literal value.
  const keys = [];
  for (const p of om.properties) {
    if (ts.isShorthandPropertyAssignment(p)) keys.push({ key: p.name.text, ref: p.name.text });
    else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (ts.isStringLiteral(p.initializer) || ts.isNumericLiteral(p.initializer))) {
      keys.push({ key: p.name.text, literal: p.initializer.getText(sf) });
    } else fail(`OM in ${srcName} has a key skac cannot export by name: ${p.getText(sf).slice(0, 40)}`, 'use a shorthand key (OM = { spring, ring }) or a string or number literal');
  }

  const refs = new Map([...decls].map(([n, d]) => [n, [...referenced(ts, d.st)].filter((r) => r !== n && decls.has(r) && r !== 'OM')]));
  const hostOnly = new Map([...decls].map(([n, d]) => [n, [...referenced(ts, d.st)].filter((r) => HOST_ONLY.has(r))]));
  const closure = (n, seen = new Set()) => {
    if (seen.has(n)) return seen;
    seen.add(n);
    for (const r of refs.get(n) ?? []) closure(r, seen);
    return seen;
  };

  const leftOut = [];
  const kept = [];
  for (const k of keys) {
    if (!k.ref) { kept.push(k); continue; }
    const d = decls.get(k.ref);
    if (LEFT_OUT[k.key]) { leftOut.push({ name: k.key, why: LEFT_OUT[k.key] }); continue; }
    if (!d) { leftOut.push({ name: k.key, why: 'is not declared at the top level of the lib' }); continue; }
    const bad = [...closure(k.ref)].find((n) => decls.get(n).mutable || LEFT_OUT[n] || hostOnly.get(n).length);
    if (bad) {
      const why = decls.get(bad).mutable ? `closes over ${bad}, module state a worklet cannot carry`
        : LEFT_OUT[bad] ? `uses ${bad}, which is left out` : `uses ${hostOnly.get(bad)[0]}, which a worklet does not have`;
      leftOut.push({ name: k.key, why });
      continue;
    }
    kept.push(k);
  }

  const needed = new Set();
  for (const k of kept) if (k.ref) closure(k.ref, needed);
  const exported = new Set(kept.filter((k) => k.ref).map((k) => k.ref));

  const chunks = [];
  for (const [n, d] of decls) {
    if (!needed.has(n)) continue;
    const st = d.st;
    const comments = ts.getLeadingCommentRanges(source, st.getFullStart()) ?? [];
    const start = comments.length ? comments[0].pos : st.getStart(sf);
    let text = splice(source.slice(start, st.getEnd()), start, workletEdits(ts, sf, st));
    if (exported.has(n)) {
      const at = st.getStart(sf) - start; // the declaration itself, after its comments
      text = text.slice(0, at) + 'export ' + text.slice(at);
    }
    chunks.push(text.replace(/^ {2}/gm, ''));
  }
  for (const k of kept) if (k.literal !== undefined) chunks.push(`export const ${k.key} = ${k.literal};`);

  const lines = [
    source.slice(0, call.getStart(sf)).trimEnd(),
    '',
    `// skac libs: ${name}.worklet.ts, generated from ${srcName} by skia-motion-agentic-cli ${version} (\`skac update\`). Do not edit; edit the lib and run \`skac update\`.`,
    `// Every function carries 'worklet'; each OM key is a named export: import { ${kept.find((k) => k.ref)?.key ?? 'spring'} } from './${name}.worklet'.`,
    ...(notice ? [`// ${notice}`] : []),
    `// Left out of this build, not exported (${leftOut.length}):`,
    ...leftOut.map((l) => `//   ${l.name}: ${l.why}`),
    '// @ts-nocheck',
    '',
    chunks.join('\n\n'),
    '',
  ];
  return { code: lines.join('\n'), exports: kept.map((k) => k.key), leftOut };
};

/** The three generated files of a lib, from its source bytes; `notice` is its Required Notice line, if any. */
const generated = (ts, name, bytes, srcName, notice) => {
  const [js, dts, worklet] = libPaths(name);
  const { code } = buildWorklet(ts, bytes.toString('utf8'), { name, srcName, notice });
  const typing = [
    `// ${name}: types for ${name}.js, the plain build, generated by skia-motion-agentic-cli. A loose surface; the worklet build ${name}.worklet.ts is typed from its source.`,
    ...(notice ? [`// ${notice}`] : []),
    'declare const OM: Record<string, any>;',
    'export default OM;',
    '',
  ].join('\n');
  return new Map([[js, bytes], [dts, typing], [worklet, code]]);
};

/**
 * The three files a lib puts in a project, as project path -> text or bytes. Throws an error with a hint when the source is missing.
 * @param {*} ts  the TypeScript module
 * @param {string} name
 * @param {string} srcPath  absolute path of the lib's .js file
 */
export const libFiles = (ts, name, srcPath) => {
  if (!existsSync(srcPath)) {
    fail(`lib ${name}: ${srcPath} does not exist`, `fix the path under "libs" in skia-motion.json (or ${userLibsFile()}), or remove the lib`);
  }
  const bytes = readFileSync(srcPath);
  return generated(ts, name, bytes, basename(srcPath), requiredNotice(srcPath, bytes.toString('utf8')));
};

/**
 * The four files a built-in lib puts in a project: its fetched source byte for byte, its licence beside it, the typing and the worklet build.
 * A copy already in the project whose sha256 is the table's is reused, so an update needs no network. A fetched file with another hash is refused.
 * @param {{projectDir: string, fetcher?: (url: string) => Buffer}} opts
 */
export const builtinFiles = (ts, name, { projectDir, fetcher = fetchSync }) => {
  const entry = BUILTIN_LIBS[name];
  const [src, licence] = Object.keys(entry.files);
  const [jsPath, , , licPath] = libPaths(name, true);
  const get = (file, local) => {
    const want = entry.files[file];
    const have = existsSync(join(projectDir, local)) ? readFileSync(join(projectDir, local)) : null;
    if (have && sha(have) === want) return have;
    const url = rawUrl(entry, file);
    const got = Buffer.from(fetcher(url));
    if (sha(got) !== want) {
      fail(`${file} fetched from ${url} has sha256 ${sha(got)}, not the ${want} skac expects`,
        `refused, nothing was written; check the network path, or use a local copy (${overrideHint(name)})`);
    }
    return got;
  };
  const bytes = get(src, jsPath);
  const lic = get(licence, licPath);
  const text = bytes.toString('utf8');
  const find = (t) => /^.*Required Notice:.*$/m.exec(t)?.[0].replace(/^[\s*/>#-]*/, '') ?? null;
  const files = generated(ts, name, bytes, basename(src), find(text) ?? find(lic.toString('utf8')));
  files.set(licPath, lic);
  return files;
};
