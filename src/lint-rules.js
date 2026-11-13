// Source lint rules. One function per rule, each with a passing and a failing fixture in test/fixtures/lint/.
// A rule's `check(ctx)` returns raw hits `{ node, message, value?, edits? }`; src/lint.js adds the shared
// finding fields (ruleId, severity, fix, docs, file, line, column). `edits` are `{ start, end, text }`.
import { basename, dirname, extname, join, relative } from 'node:path';
import { existsSync } from 'node:fs';

const WALL_CLOCK_CALLS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame']);
const MOTION_FNS = new Set(['flow', 'track', 'seg', 'hop', 'env', 'wave']);
const OK_LITERALS = new Set([0, 1, 2]);
const TEXT_TAGS = new Set(['Text', 'Paragraph', 'TextPath']);
const TIME_NAMES = new Set(['t', 'ms', 'frame']);
const BOUNCE_LIMIT = 0.05;
const PATH_STRING = /^\s*[MmLlCcQqSsTtAaZzHhVv]\s*-?[\d.]/;

/** Walk every node under `node`, depth first. Return `false` from `visit` to skip a node's children. */
export const walk = (ts, node, visit) => {
  if (visit(node) === false) return;
  ts.forEachChild(node, (c) => walk(ts, c, visit));
};

const calleeName = (ts, call) => {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : null;
};
const dotted = (ts, e) => (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) ? `${e.expression.text}.${e.name.text}` : null);
const isNumber = (ts, n) => ts.isNumericLiteral(n) || (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand));
const numberValue = (ts, n) => (ts.isNumericLiteral(n) ? Number(n.text) : -Number(n.operand.text));
const unparen = (ts, n) => {
  while (n && ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

/** Relative import specifier for the engine, from a file to `<project>/src/motion/motion`. */
const motionSpecifier = (ctx) => {
  let rel = relative(dirname(ctx.filePath), join(ctx.projectDir, 'src', 'motion', 'motion')).split('\\').join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
};

const importsName = (ts, sf, name) => {
  let found = false;
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause) continue;
    const { name: def, namedBindings } = s.importClause;
    if (def && def.text === name) found = true;
    if (namedBindings && ts.isNamedImports(namedBindings) && namedBindings.elements.some((e) => e.name.text === name)) found = true;
  }
  return found;
};

const importEdit = (ctx, name) => {
  if (importsName(ctx.ts, ctx.sf, name)) return null;
  const imports = ctx.sf.statements.filter((s) => ctx.ts.isImportDeclaration(s));
  const line = `import { ${name} } from '${motionSpecifier(ctx)}';`;
  if (!imports.length) return { start: 0, end: 0, text: `${line}\n` };
  const at = imports[imports.length - 1].getEnd();
  return { start: at, end: at, text: `\n${line}` };
};

const mentionsTime = (ts, node) => {
  let hit = false;
  walk(ts, node, (n) => {
    if (ts.isIdentifier(n) && TIME_NAMES.has(n.text)) hit = true;
  });
  return hit;
};

/** What a branch draws: an SVG path string or a JSX element, unwrapped from parentheses and one-statement blocks. */
const shapeOf = (ts, sf, n) => {
  n = unparen(ts, n);
  if (n && ts.isBlock(n) && n.statements.length === 1) {
    const s = n.statements[0];
    n = ts.isReturnStatement(s) ? s.expression : ts.isExpressionStatement(s) ? s.expression : null;
    n = unparen(ts, n);
  }
  if (!n) return null;
  if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && PATH_STRING.test(n.text)) return { kind: 'path', text: n.text };
  if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return { kind: 'jsx', text: n.getText(sf).replace(/\s+/g, ' ') };
  return null;
};

export const LINT_RULES = {
  'skac/no-wall-clock': {
    default: 'error',
    docs: 'motion/principles',
    fix: 'Read time from the clock (useClockMs) and make every value a function of t.',
    check({ ts, sf }) {
      const hits = [];
      walk(ts, sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const e = n.expression;
        const d = dotted(ts, e);
        if (d === 'Date.now' || d === 'performance.now') hits.push({ node: n, message: `${d}() reads the wall clock; the render and the app must agree on t`, value: d });
        else if (ts.isIdentifier(e) && WALL_CLOCK_CALLS.has(e.text)) hits.push({ node: n, message: `${e.text}() runs on real time, not on t`, value: e.text });
        else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'window' && WALL_CLOCK_CALLS.has(e.name.text)) hits.push({ node: n, message: `window.${e.name.text}() runs on real time, not on t`, value: e.name.text });
      });
      return hits;
    },
  },

  'skac/no-random': {
    default: 'error',
    fixable: true,
    docs: 'motion/principles',
    fix: 'Use seeded(i) from the motion engine: a stable value per item, the same on every frame and every render.',
    check(ctx) {
      const { ts, sf } = ctx;
      const hits = [];
      let n = 0;
      walk(ts, sf, (node) => {
        if (!ts.isPropertyAccessExpression(node) || dotted(ts, node) !== 'Math.random') return;
        const call = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
        const hit = { node: call || node, message: 'Math.random() gives a new value on every call, so a frame depends on how often it was drawn' };
        if (call && call.arguments.length === 0) {
          const imp = importEdit(ctx, 'seeded');
          hit.edits = [{ start: call.getStart(sf), end: call.getEnd(), text: `seeded(${n++})` }, ...(imp ? [imp] : [])];
        }
        hits.push(hit);
      });
      return hits;
    },
  },

  'skac/no-hand-easing': {
    default: 'error',
    docs: 'motion/principles',
    fix: 'Use EASE_OUT, EASE_IN_OUT or EASE_IN, and flow or track for keyframes, from the motion engine.',
    check({ ts, sf, filePath }) {
      if (basename(filePath).startsWith('motion.')) return [];
      const hits = [];
      const nameOf = (n) => {
        const p = n.parent;
        if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
        return '';
      };
      walk(ts, sf, (n) => {
        if (ts.isCallExpression(n) && calleeName(ts, n) === 'bezier' && n.arguments.length === 4 && n.arguments.every((a) => isNumber(ts, a))) {
          hits.push({ node: n, message: 'a hand-written bezier(...) curve; the engine owns the easings' });
        } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Easing') {
          hits.push({ node: n, message: `Easing.${n.name.text} is a hand-picked curve; the engine owns the easings` });
        } else if (ts.isArrayLiteralExpression(n) && n.elements.length === 4 && n.elements.every((a) => isNumber(ts, a)) && /ease|bezier|curve|cubic/i.test(nameOf(n))) {
          hits.push({ node: n, message: 'a hand-written cubic-bezier array; the engine owns the easings' });
        } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /cubic-bezier\(/.test(n.text)) {
          hits.push({ node: n, message: 'a hand-written cubic-bezier(...) string; the engine owns the easings' });
        }
      });
      return hits;
    },
  },

  'skac/no-bouncy-spring': {
    default: 'error',
    docs: 'motion/anticipation',
    fix: `Pass a bounce of ${BOUNCE_LIMIT} or less to spring(t, d, bounce): overshoot is 5% at most.`,
    check({ ts, sf }) {
      const hits = [];
      walk(ts, sf, (n) => {
        if (!ts.isCallExpression(n) || calleeName(ts, n) !== 'spring' || n.arguments.length < 3) return;
        const b = n.arguments[2];
        if (isNumber(ts, b) && numberValue(ts, b) > BOUNCE_LIMIT) {
          hits.push({ node: b, message: `spring bounce ${numberValue(ts, b)} overshoots by more than 5%`, value: numberValue(ts, b) });
        }
      });
      return hits;
    },
  },

  'skac/no-text-in-character': {
    default: 'error',
    docs: 'motion/principles',
    fix: 'Draw words in the screen around the character, not in the character: remove the text element.',
    check({ ts, sf, filePath }) {
      const ext = extname(filePath);
      const base = filePath.slice(0, filePath.length - ext.length);
      if (!existsSync(`${base}.rig.ts`)) return [];
      const hits = [];
      walk(ts, sf, (n) => {
        if (!ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        const tag = ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName;
        if (ts.isIdentifier(tag) && TEXT_TAGS.has(tag.text)) hits.push({ node: n, message: `<${tag.text}> draws text in a character composition`, value: tag.text });
      });
      return hits;
    },
  },

  'skac/no-magic-motion': {
    default: 'off', // opt in with "rules": { "skac/no-magic-motion": "warn" }; the rig rules judge what the numbers do
    docs: 'motion/principles',
    fix: 'Name the time or position in a const token object (BUILD, BEAT, ACT) and pass the token.',
    check({ ts, sf }) {
      const hits = [];
      const seen = new Set();
      const inTokenObject = (n) => {
        for (let p = n.parent; p; p = p.parent) {
          if (ts.isObjectLiteralExpression(p)) {
            for (let q = p.parent; q; q = q.parent) {
              if (ts.isVariableDeclarationList(q)) return (q.flags & ts.NodeFlags.Const) !== 0;
              if (ts.isFunctionLike(q) || ts.isBlock(q)) break;
            }
          }
        }
        return false;
      };
      walk(ts, sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const name = calleeName(ts, n);
        if (!name || !MOTION_FNS.has(name) || inTokenObject(n)) return;
        for (const arg of n.arguments) {
          walk(ts, arg, (m) => {
            if (ts.isCallExpression(m) && MOTION_FNS.has(calleeName(ts, m))) return false; // its own check
            if (!ts.isNumericLiteral(m)) return;
            const v = Number(m.text);
            if (OK_LITERALS.has(v) || seen.has(m.getStart(sf))) return;
            seen.add(m.getStart(sf));
            hits.push({ node: m, message: `literal ${m.text} in ${name}(...) is a magic number`, value: v });
          });
        }
      });
      return hits;
    },
  },

  'skac/no-face-swap': {
    default: 'warn',
    docs: 'motion/faces',
    fix: 'Drive face channels through faceAt so the face eases between shapes, never swaps in one frame.',
    check({ ts, sf }) {
      const hits = [];
      const branches = (n) => {
        if (ts.isConditionalExpression(n)) return [n.condition, n.whenTrue, n.whenFalse];
        if (ts.isIfStatement(n) && n.elseStatement) return [n.expression, n.thenStatement, n.elseStatement];
        return null;
      };
      walk(ts, sf, (n) => {
        const b = branches(n);
        if (!b || !mentionsTime(ts, b[0])) return;
        const a = shapeOf(ts, sf, b[1]);
        const c = shapeOf(ts, sf, b[2]);
        if (a && c && a.kind === c.kind && a.text !== c.text) {
          hits.push({ node: n, message: `a condition on time picks between two different ${a.kind === 'path' ? 'path strings' : 'JSX shapes'}`, value: a.kind });
        }
      });
      return hits;
    },
  },

  // Raised by the engine in lint.js, not by a walk of the tree.
  'skac/disable-needs-reason': {
    default: 'error',
    docs: 'motion/checks',
    fix: 'Write the reason after the rule id: // skac-disable-next-line skac/<id> -- why this is fine',
    check: () => [],
  },
};
