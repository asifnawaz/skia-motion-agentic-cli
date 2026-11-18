import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { transformFileSync } = require('@babel/core');
const ts = require('typescript');

test('Worklets 0.13.0 initializes machine helpers before capturing them', () => {
  assert.equal(require('react-native-worklets/package.json').version, '0.13.0');

  const load = (name, imports = {}) => {
    const filename = fileURLToPath(new URL(`../../templates/motion/${name}.ts`, import.meta.url));
    const { code } = transformFileSync(filename, {
      babelrc: false,
      configFile: false,
      presets: [require.resolve('@babel/preset-typescript')],
      plugins: [require.resolve('react-native-worklets/plugin')],
      envName: 'development',
    });
    // Evaluate CommonJS in Node and mirror Metro's var bindings for factory initializers.
    const { outputText } = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 },
    });
    const exports = {};
    runInNewContext(outputText, {
      __DEV__: true,
      exports,
      global: { Error },
      require(specifier) {
        assert.ok(Object.hasOwn(imports, specifier), `unexpected import ${specifier}`);
        return imports[specifier];
      },
    }, { filename, displayErrors: false });
    return exports;
  };

  const core = load('machine', { './motion': load('motion') });
  const { compile, start, advance, pose } = core;
  assert.equal(typeof compile.__workletHash, 'number');
  const machine = {
    schema: 'skac.machine/1',
    values: { finish: { type: 'trigger' } },
    layers: [{
      name: 'ring', entry: 'calling',
      states: { calling: { clip: 'ripple', loop: 'loop' } },
      transitions: [{ from: 'calling', to: 'exit', when: [['finish']] }],
    }],
  };
  const clips = { ripple: { ms: 500, play: (ms) => ({ channels: { radius: ms } }) } };
  const compiled = compile(machine, clips);
  assert.equal(compiled.layers[0].states[0].ms, 500);
  const clock = (_name, t) => t;
  const finished = advance(compiled, start(compiled), 200, [{ at: 100, value: 'finish', to: true }], clock);
  assert.equal(pose(compiled, clips, finished, 200, clock).channels.radius, 100);

  const seen = new Set();
  const checkCaptures = (worklet) => {
    if (seen.has(worklet)) return;
    seen.add(worklet);
    for (const [index, capture] of (worklet?.__closure ?? []).entries()) {
      assert.notEqual(capture, undefined, `${worklet.name} has an undefined capture at index ${index}`);
      if (typeof capture === 'function') checkCaptures(capture);
    }
  };
  Object.values(core).forEach(checkCaptures);
});
