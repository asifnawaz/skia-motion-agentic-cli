import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');
const dir = fileURLToPath(new URL('../../templates/motion/', import.meta.url));

const startsWithWorklet = (fn) => {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'worklet';
};
// React hooks (useLoopClock, useClockMs...) run on the JS thread in a component; they are not worklets.
const isHook = (name) => /^use[A-Z]/.test(name);
const isExported = (node) => !!node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Exported functions of a source text that do not start with 'worklet'. */
const missing = (text, name) => {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bad = [];
  for (const st of sf.statements) {
    if (!isExported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.body && !(st.name && isHook(st.name.text)) && !startsWithWorklet(st)) bad.push(st.name ? st.name.text : 'default');
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && !startsWithWorklet(init)) bad.push(d.name.getText(sf));
      }
    }
  }
  return bad;
};

test('the checker sees a function without the worklet directive', () => {
  assert.deepEqual(missing(`export function a() { return 1; }\nexport const b = () => 2;\nexport function c() { 'worklet'; return 3; }`, 'x.ts'), ['a', 'b']);
});

for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
  test(`templates/motion/${f}: every exported function starts with 'worklet'`, () => {
    const bad = missing(readFileSync(join(dir, f), 'utf8'), f);
    assert.deepEqual(bad, [], `${f}: exported function(s) ${bad.join(', ')} must start with 'worklet'; they run on the UI thread`);
  });
}
