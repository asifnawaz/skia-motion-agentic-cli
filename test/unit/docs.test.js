import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.js';
import { docsCommand, listTopics } from '../../src/docs.js';
import { tmp, write } from './helpers.js';

const project = () => {
  const root = tmp();
  write(join(root, 'skia-motion.json'), '{"docs":["mydocs"]}');
  write(join(root, 'mydocs', 'house', 'rules.md'), '# House rules\nAlways squash on landing.\n');
  return loadConfig(root);
};

test('docs: topics include config dirs, search finds lines, reads are logged', () => {
  const cfg = project();
  const topics = listTopics(cfg);
  assert.ok(topics.some((t) => t.name === 'house/rules' && t.heading === 'House rules' && t.lines === 2));
  const hit = docsCommand(cfg, { search: 'SQUASH' }).hits.find((h) => h.topic === 'house/rules');
  assert.deepEqual([hit.line, hit.text], [2, 'Always squash on landing.']);
  const read = docsCommand(cfg, { topic: 'house/rules', as: 'tester' });
  assert.equal(read.lines, 2);
  const log = readFileSync(join(cfg.out, 'docs-reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).topic, 'house/rules');
  assert.equal(log.at(-1).as, 'tester');
  assert.throws(() => docsCommand(cfg, { topic: 'house/rule' }), /no docs topic/);
});

const longProject = () => {
  const root = tmp();
  write(join(root, 'skia-motion.json'), '{"docs":["mydocs"]}');
  const body = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  const text = `# Big\n\n## Alpha\n${body(100)}\n### Alpha deep\n${body(60)}\n## Beta check\n${body(100)}\n\`\`\`\n## not a heading\n\`\`\`\n## Gamma\n${body(10)}\n`;
  write(join(root, 'mydocs', 'big.md'), text);
  return loadConfig(root);
};

test('docs: a long topic lists sections with read commands; a short one stays whole', () => {
  const cfg = longProject();
  const r = docsCommand(cfg, { topic: 'big' });
  assert.equal(r.text, undefined);
  assert.match(r.notice, /sections/);
  assert.deepEqual(r.sections.map((s) => s.heading), ['Alpha', 'Alpha deep', 'Beta check', 'Gamma']);
  assert.equal(r.sections[2].read, 'skac docs big "Beta check"');
  assert.equal(r.sections[0].lines, 162); // ## covers its ### child
  assert.ok(docsCommand(project(), { topic: 'house/rules' }).text);
});

test('docs: one section comes back alone, exact first then by words', () => {
  const cfg = longProject();
  const a = docsCommand(cfg, { topic: 'big', section: 'alpha' });
  assert.equal(a.section, 'Alpha');
  assert.ok(a.text.includes('### Alpha deep'));
  assert.ok(!a.text.includes('## Beta'));
  const d = docsCommand(cfg, { topic: 'big', section: 'ALPHA deep' });
  assert.ok(d.text.startsWith('### Alpha deep') && !d.text.includes('## Beta'));
  assert.equal(docsCommand(cfg, { topic: 'big', section: 'check' }).section, 'Beta check');
});

test('docs: a bad or ambiguous section errors with the closest headings', () => {
  const cfg = longProject();
  assert.throws(() => docsCommand(cfg, { topic: 'big', section: 'Gama' }), (e) => /no section/.test(e.message) && /Gamma/.test(e.hint));
  assert.throws(() => docsCommand(cfg, { topic: 'big', section: 'a' }), (e) => /several/.test(e.message) && /Alpha/.test(e.hint));
});
