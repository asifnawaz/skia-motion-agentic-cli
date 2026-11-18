// Bundle a scene into one TypeScript file: the component, the rig and the drawing whole, plus only the top-level
// declarations of the engine files they reach, followed through identifiers (TypeScript API, no regex on source).
// A top-level name that two files share is renamed (<name>_<file>) and its references rewritten.
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { fail } from './util.js';

export const parse = (ts, abs, text = readFileSync(abs, 'utf8')) => ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true,
  abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * Every module specifier in a file, read with TypeScript's parser: `import ... from`, side-effect `import '…'`,
 * `import type`, `export ... from` and `export * from`. A relative `import()`, `require()` or `import('…').T`
 * is refused, because the bundle could not follow it.
 */
export const specifiers = (ts, sf, { staticOnly = true } = {}) => {
  const out = [];
  const refuse = (spec) => fail(`${basename(sf.fileName)} loads ${spec} at run time or through an import type`,
    'use a static import at the top of the file, so --export can bundle it');
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text });
    } else if (staticOnly && ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0].text.startsWith('.')) {
      refuse(node.arguments[0].text);
    } else if (staticOnly && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
      && node.argument.literal.text.startsWith('.')) {
      refuse(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

const mods = (ts, st) => ts.getModifiers?.(st) || st.modifiers || [];
const isFnInit = (ts, d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));

const bindingNames = (ts, n, out = []) => {
  if (ts.isIdentifier(n)) out.push(n.text);
  else if (!ts.isOmittedExpression(n)) for (const e of n.elements) bindingNames(ts, e.name, out);
  return out;
};

/** An identifier that names a property, a label or a JSX attribute rather than a binding. */
const isLabel = (ts, n) => {
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) return (p.name ?? p.right) === n;
  if (ts.isBindingElement(p)) return p.propertyName === n;
  return (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)
    || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p) || ts.isJsxAttribute(p))
    && p.name === n || ((ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) && p.label === n);
};

/** The identifiers in a node that stand for a binding (not property names). */
const identifiers = (ts, node) => {
  const out = [];
  const visit = (n) => {
    if (ts.isIdentifier(n) && !isLabel(ts, n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
};

const DECL = (ts, st) => ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isVariableStatement(st)
  || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st);

/**
 * @param {*} ts
 * @param {string} name  the scene's name
 * @param {{rig?: {abs: string, sf: *}, clips?: {abs: string, sf: *}, draw: {abs: string, sf: *}, component: {abs: string, sf: *}}} scene
 * @param {(fromAbs: string, spec: string) => string | {abs: string, sf: *} | {external: string, file: string}} loadLocal
 *   An engine path to tree-shake, a parsed helper to keep, or an external module replacing the local file.
 * @param {{mapExternal?: (spec: string) => string, reserved?: Set<string>}} [options]
 * @returns {{text: string, required: string[], lib: boolean, sources: string[]}}
 */
export const bundleScene = (ts, name, scene, loadLocal, { mapExternal = (spec) => spec, reserved } = {}) => {
  const modules = new Map(); // abs -> module
  const order = []; // modules in dependency order (a module after the ones it imports)
  const machine = Boolean(scene.clips);
  const primary = scene.clips ?? scene.rig;
  const primaryKind = machine ? 'clips' : 'rig';
  const local = (spec) => spec.startsWith('.') || (machine && isAbsolute(spec));

  const load = (abs, kind, sf = parse(ts, abs)) => {
    if (modules.has(abs)) return modules.get(abs);
    const file = basename(abs);
    const m = { abs, kind, file, sf, units: [], byName: new Map(), imports: new Map(), localExports: new Map(), exportsFrom: [], stars: [], mark: false };
    modules.set(abs, m);
    specifiers(ts, sf);
    const target = (spec) => {
      if (!machine || kind === 'component') {
        if (spec === `./${name}.${primaryKind}`) return modules.get(primary.abs) ?? load(primary.abs, primaryKind, primary.sf);
        if (spec === `./${name}.draw`) return modules.get(scene.draw.abs) ?? load(scene.draw.abs, 'draw', scene.draw.sf);
      }
      const dep = loadLocal(abs, spec);
      if (typeof dep === 'string') return load(dep, 'engine');
      if (dep.external) return dep;
      const depKind = dep.abs === primary.abs ? primaryKind : dep.abs === scene.draw.abs ? 'draw' : 'helper';
      return modules.get(dep.abs) ?? load(dep.abs, depKind, dep.sf);
    };
    sf.statements.forEach((st, index) => {
      if (ts.isImportDeclaration(st)) {
        const spec = st.moduleSpecifier.text;
        const clause = st.importClause;
        const dep = local(spec) ? target(spec) : null;
        if (!clause) {
          const ext = dep ? dep.external : mapExternal(spec);
          if (ext) m.sideEffects = [...(m.sideEffects ?? []), ext];
          return;
        }
        const bind = (name, imported, typeOnly) => m.imports.set(name, dep ? { target: dep, imported, spec, typeOnly } : { ext: mapExternal(spec), imported, typeOnly });
        if (clause.name) bind(clause.name.text, 'default', clause.isTypeOnly);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) bind(nb.name.text, '*', clause.isTypeOnly);
        else if (nb) for (const el of nb.elements) bind(el.name.text, (el.propertyName ?? el.name).text, clause.isTypeOnly || el.isTypeOnly);
      } else if (ts.isExportDeclaration(st)) {
        const clause = st.exportClause;
        if (st.moduleSpecifier) {
          const spec = st.moduleSpecifier.text;
          if (!local(spec) && !machine) fail(`${file} re-exports from ${spec}`, 'import it where it is used; a bundled scene re-exports only its own and engine names');
          const dep = local(spec) ? target(spec) : { external: mapExternal(spec), file: spec };
          if (!clause) m.stars.push(dep);
          else if (ts.isNamespaceExport(clause)) fail(`${file} has export * as ${clause.name.text}`, 'use named exports');
          else for (const el of clause.elements) m.exportsFrom.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text, target: dep, typeOnly: st.isTypeOnly || el.isTypeOnly });
        } else if (clause && ts.isNamedExports(clause)) {
          for (const el of clause.elements) m.localExports.set(el.name.text, { local: (el.propertyName ?? el.name).text, typeOnly: st.isTypeOnly || el.isTypeOnly });
        }
      } else if (ts.isExportAssignment(st)) {
        fail(`${file} has a default export`, 'use named exports; a bundled scene cannot carry a default export');
      } else if (DECL(ts, st)) {
        const names = ts.isVariableStatement(st) ? st.declarationList.declarations.flatMap((d) => bindingNames(ts, d.name)) : [st.name?.text].filter(Boolean);
        const clash = kind === 'component' ? undefined : names.find((n) => reserved?.has(n));
        if (clash) fail(`${file} declares the reserved name ${clash}`, `rename ${clash}; the generated component declares it`);
        const exported = mods(ts, st).some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
        const fns = ts.isFunctionDeclaration(st) ? names
          : ts.isVariableStatement(st) ? st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name) && isFnInit(ts, d)).map((d) => d.name.text) : [];
        const unit = { m, st, index, names, exported, fns, in: false, outs: new Map(), refs: identifiers(ts, st) };
        m.units.push(unit);
        for (const n of names) m.byName.set(n, unit);
      } else if (ts.isModuleDeclaration(st)) {
        fail(`${file} declares a namespace or module`, 'a bundled scene cannot carry one; use plain top-level declarations');
      } else if (kind === 'engine') {
        fail(`${file} has a top-level statement that runs code (${st.getText(sf).slice(0, 40)}...)`,
          'an engine file may hold only declarations and imports, so a scene can take just the parts it uses');
      } else {
        m.units.push({ m, st, index, names: [], exported: false, fns: [], in: false, outs: new Map(), refs: identifiers(ts, st) });
      }
    });
    order.push(m); // after every module it imports
    return m;
  };

  const comp = load(scene.component.abs, 'component', scene.component.sf);
  if (!modules.has(primary.abs)) load(primary.abs, primaryKind, primary.sf);
  if (!modules.has(scene.draw.abs)) load(scene.draw.abs, 'draw', scene.draw.sf);
  const isPublic = (m) => machine ? m === comp : m.kind !== 'engine';

  const shadowed = new Set();
  if (machine) {
    // Bind each file in its original lexical scope before flattening the imports. Module resolution is handled below.
    const options = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (file) => modules.get(file)?.sf;
    const checker = ts.createProgram([...modules.keys()], options, host).getTypeChecker();
    const meaning = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;
    for (const m of order) {
      const bindings = new Set([...m.byName.keys(), ...m.imports.keys()].map((name) => checker.resolveName(name, m.sf, meaning, false))
        .filter(Boolean).map((symbol) => checker.getExportSymbolOfSymbol(symbol)));
      for (const u of m.units) u.refs = u.refs.filter((id) => {
        const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
          ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
        if (symbol && bindings.has(checker.getExportSymbolOfSymbol(symbol))) return true;
        shadowed.add(id.text);
        return false;
      });
    }
  }

  const asTypeOnly = (r, typeOnly) => r?.ext && typeOnly ? { ...r, typeOnly } : r;

  /** The unit that declares `exported` in a module, following re-exports. */
  const resolveExport = (m, exported, from, seen = new Set()) => {
    if (seen.has(m)) return null;
    seen.add(m);
    if (exported === '*' || exported === 'default') {
      fail(`${from} imports ${exported === '*' ? 'a whole module' : 'a default export'} from ${m.file}`, 'use named imports; the bundle keeps only the declarations a scene uses');
    }
    if (m.external) return { ext: m.external, name: exported };
    const own = m.byName.get(exported);
    if (own && (own.exported || m.kind !== 'engine')) return { m, unit: own, name: exported };
    const le = m.localExports.get(exported);
    if (le) {
      const u = m.byName.get(le.local);
      if (u) return { m, unit: u, name: le.local };
      const b = m.imports.get(le.local);
      if (machine && b?.ext) return { ext: b.ext, name: b.imported, typeOnly: le.typeOnly || b.typeOnly };
      if (b?.target) return asTypeOnly(resolveExport(b.target, b.imported, m.file, seen), le.typeOnly || b.typeOnly);
    }
    for (const e of m.exportsFrom) if (e.exported === exported) return asTypeOnly(resolveExport(e.target, e.imported, m.file, seen), e.typeOnly);
    for (const s of m.stars) {
      const r = resolveExport(s, exported, m.file, seen);
      if (r) return r;
    }
    return own ? { m, unit: own, name: exported } : null;
  };

  const ext = new Map(); // `${spec}\0${imported}` -> { spec, imported, local, typeOnly, out }
  const extSide = new Set();
  const include = (u) => {
    if (u.in) return;
    u.in = true;
    for (const id of u.refs) reach(u.m, id.text);
  };
  const reach = (m, ident) => {
    const u = m.byName.get(ident);
    if (u) return include(u);
    const b = m.imports.get(ident);
    if (!b) return;
    if (!b.ext) {
      const r = resolveExport(b.target, b.imported, m.file);
      if (!r) fail(`${m.file} imports ${b.imported} from ${b.spec}, which does not declare or export it`, 'fix the import');
      if (!r.ext) return include(r.unit);
      b.ext = r.ext;
      b.imported = r.name;
      b.typeOnly ||= r.typeOnly;
    }
    const key = `${b.ext}\0${b.imported}`;
    const e = ext.get(key) ?? { spec: b.ext, imported: b.imported, local: ident, typeOnly: true, locals: new Set() };
    e.locals.add(ident);
    ext.set(key, e);
  };

  // Scene modules are taken whole; engine modules by reach.
  for (const m of order) if (m.kind !== 'engine') for (const u of m.units) include(u);
  // Re-exports in scene modules reach an engine name even if no code uses it.
  const reexports = [];
  for (const m of order.filter(isPublic)) {
    for (const e of m.exportsFrom) {
      const r = resolveExport(e.target, e.imported, m.file);
      if (!r) fail(`${m.file} re-exports ${e.imported}, which does not exist`, 'fix the export');
      include(r.unit);
      reexports.push({ exported: e.exported, r, typeOnly: e.typeOnly });
    }
    for (const s of m.stars) fail(`${m.file} has export * from ${basename(s.abs)}`, 'list the names: export { a, b } from ...');
  }

  // Names: scene files keep theirs (rig, draw, component in that order); externals next; engine declarations rename on a clash.
  const taken = new Set();
  const alloc = (want, hint, keep = false) => {
    let out = want;
    for (let i = 2; taken.has(out) || (shadowed.has(out) && !(keep && out === want)); i++) {
      out = i === 2 ? `${want}_${hint}` : `${want}_${hint}${i - 1}`;
    }
    taken.add(out);
    return out;
  };
  const hintOf = (m) => basename(m.abs).replace(/\.(worklet\.)?tsx?$/, '').replace(/[^A-Za-z0-9_$]/g, '_');
  const priorities = ['rig', 'clips', 'draw', 'component', 'helper', 'engine'];
  const byKind = [...order].sort((a, b) => priorities.indexOf(a.kind) - priorities.indexOf(b.kind));
  const allocUnits = (m) => {
    for (const u of m.units) if (u.in) for (const n of u.names) u.outs.set(n, alloc(n, hintOf(m), m === comp));
  };
  for (const m of byKind.filter((x) => x.kind !== 'engine')) allocUnits(m);
  for (const m of order) for (const [local, b] of m.imports) {
    if (!b.ext) continue;
    const e = ext.get(`${b.ext}\0${b.imported}`);
    if (!e || !e.locals.has(local)) continue;
    if (e.out === undefined) e.out = alloc(local, 'import');
    if (!b.typeOnly) e.typeOnly = false;
  }
  for (const m of order.filter((x) => x.kind === 'engine')) allocUnits(m);

  const outOf = (m, ident) => {
    const u = m.byName.get(ident);
    if (u) return u.outs.get(ident);
    const b = m.imports.get(ident);
    if (!b) return undefined;
    if (b.ext) return ext.get(`${b.ext}\0${b.imported}`)?.out;
    const r = resolveExport(b.target, b.imported, m.file);
    return r?.unit.outs.get(r.name);
  };

  const unitText = (u) => {
    const { m, st } = u;
    const full = m.sf.getFullText();
    const ranges = ts.getLeadingCommentRanges(full, st.getFullStart()) ?? [];
    const first = m.sf.statements.find((s) => s.kind !== ts.SyntaxKind.ImportDeclaration) === st;
    const keep = first ? ranges.filter((r) => full.startsWith('/**', r.pos)).slice(-1) : ranges;
    const start = keep.length ? keep[0].pos : st.getStart(m.sf);
    const edits = [];
    if (!isPublic(m)) {
      const ex = mods(ts, st).find((x) => x.kind === ts.SyntaxKind.ExportKeyword);
      if (ex) {
        let end = ex.getEnd();
        while (/\s/.test(full[end])) end++;
        edits.push({ pos: ex.getStart(m.sf), end, text: '' });
      }
    }
    for (const id of u.refs) {
      const out = outOf(m, id.text);
      if (out === undefined || out === id.text) continue;
      const p = id.parent;
      const keepName = (ts.isShorthandPropertyAssignment(p) && p.name === id) || (ts.isBindingElement(p) && p.name === id && !p.propertyName);
      edits.push({ pos: id.getStart(m.sf), end: id.getEnd(), text: keepName ? `${id.text}: ${out}` : out });
    }
    edits.sort((a, b) => b.pos - a.pos);
    let text = full.slice(start, st.getEnd());
    for (const e of edits) text = text.slice(0, e.pos - start) + e.text + text.slice(e.end - start);
    return text;
  };

  // The header of a library's worklet build (its licence and Required Notice) stays above that library's code.
  const libHeader = (m) => {
    const full = m.sf.getFullText();
    const firstSt = m.sf.statements[0];
    const head = full.slice(0, firstSt ? firstSt.getStart(m.sf) : full.length);
    const comments = (ts.getLeadingCommentRanges(full, 0) ?? []);
    const text = comments.length ? full.slice(comments[0].pos, comments[comments.length - 1].end) : head.trim();
    return text.split('\n').filter((l) => l.trim() !== '// @ts-nocheck').join('\n').trim();
  };
  const isLib = (m) => (m.kind === 'engine' || m.kind === 'helper') && m.abs.endsWith('.worklet.ts') && basename(dirname(m.abs)) === 'lib';

  const blocks = [];
  const sources = [];
  let lib = false;
  for (const m of order) {
    const used = m.units.filter((u) => u.in);
    if (!used.length) continue;
    const label = m.kind === 'component' ? `${name} component` : m.kind === 'engine' ? `engine: ${m.file}` : m.file;
    const body = used.map(unitText).join('\n\n');
    const head = isLib(m) ? `${libHeader(m)}\n` : '';
    if (isLib(m)) lib = true;
    blocks.push({ m, text: `// ---- ${label} ----\n${head}${body}\n` });
    sources.push(m.abs);
  }
  // Plain rigs keep their existing block order. Machine helpers follow dependency order.
  const rank = (b) => ['engine', 'rig', 'draw', 'component'].indexOf(b.m.kind);
  if (!machine) blocks.sort((a, b) => (rank(a) === 0 && rank(b) === 0 ? 0 : rank(a) - rank(b)));

  const lines = [];
  const quote = (spec) => machine ? JSON.stringify(spec).slice(1, -1).replaceAll("'", "\\'") : spec;
  const bySpec = new Map();
  for (const e of ext.values()) bySpec.set(e.spec, [...(bySpec.get(e.spec) ?? []), e]);
  const sideEffects = new Set(order.flatMap((m) => m.sideEffects ?? []));
  for (const s of sideEffects) {
    if (!machine || !bySpec.get(s)?.some((e) => !e.typeOnly)) lines.push(`import '${quote(s)}';`);
  }
  for (const [spec, list] of bySpec) {
    const named = list.filter((e) => e.imported !== 'default' && e.imported !== '*')
      .map((e) => `${e.typeOnly ? 'type ' : ''}${e.imported === e.out ? e.out : `${e.imported} as ${e.out}`}`);
    for (const e of list.filter((x) => x.imported === 'default')) lines.push(`import ${e.typeOnly ? 'type ' : ''}${e.out} from '${quote(spec)}';`);
    for (const e of list.filter((x) => x.imported === '*')) lines.push(`import ${e.typeOnly ? 'type ' : ''}* as ${e.out} from '${quote(spec)}';`);
    if (named.length) lines.push(`import { ${named.join(', ')} } from '${quote(spec)}';`);
  }
  const tail = [];
  for (const { exported, r, typeOnly } of reexports) {
    const out = r.unit.outs.get(r.name);
    tail.push(`export ${typeOnly ? 'type ' : ''}{ ${out === exported ? out : `${out} as ${exported}`} };`);
  }
  for (const m of order.filter(isPublic)) {
    for (const [exported, { local, typeOnly }] of m.localExports) {
      const out = outOf(m, local) ?? local;
      tail.push(`export ${typeOnly ? 'type ' : ''}{ ${out === exported ? out : `${out} as ${exported}`} };`);
    }
  }

  const compHead = (() => {
    const full = comp.sf.getFullText();
    const r = ts.getLeadingCommentRanges(full, 0) ?? [];
    return r.length ? full.slice(r[0].pos, r[r.length - 1].end) : '';
  })();

  const required = [];
  for (const m of order) for (const u of m.units) {
    if (!u.in || m.kind === 'component') continue;
    if (m.kind === 'engine' && !u.exported) continue;
    for (const f of u.fns) required.push(u.outs.get(f));
  }

  const text = [
    ...(lib ? ['// @ts-nocheck', '// (this file holds a generated build of a JavaScript library, which is untyped; its header is kept above its code)'] : []),
    ...(compHead ? [compHead] : []),
    ...lines,
    '',
    blocks.map((b) => b.text).join('\n'),
    ...(tail.length ? [tail.join('\n'), ''] : []),
  ].join('\n');
  return { text, required, lib, sources };
};
