import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes as angularNotes } from '@semantic-release/release-notes-generator';
import { generateNotes, needsFooter, parseFiles } from '../../scripts/files-footer.js';

const logger = { log() {}, error() {}, warn() {}, success() {} };
const commit = (hash, message) => ({ hash: hash.repeat(40), message, commit: { short: hash.repeat(7), long: hash.repeat(40) }, committerDate: '2026-11-25T00:00:00Z', author: {}, committer: {} });
const context = (commits) => ({
  commits, logger, cwd: process.cwd(), env: {}, options: { repositoryUrl: 'https://github.com/o/r.git' },
  lastRelease: { gitTag: 'v3.5.1', version: '3.5.1' }, nextRelease: { gitTag: 'v3.5.2', version: '3.5.2' },
});
const release = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8'));
const pluginConfig = (name) => {
  const entry = release.plugins.find((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name);
  assert.ok(entry, `${name} is configured`);
  return Array.isArray(entry) ? entry[1] : {};
};

test('a Files footer never changes the release type', async () => {
  const fix = commit('a', 'fix(runtime): a thing\n\nWhy.\n\nFiles: no change.\n\nCo-Authored-By: X <x@example.com>');
  const feat = commit('b', 'feat(format): a minor\n\nFiles: required. Run migrate.');
  const config = pluginConfig('@semantic-release/commit-analyzer');
  assert.equal(await analyzeCommits(config, context([fix])), 'patch');
  assert.equal(await analyzeCommits(config, context([fix, feat])), 'minor');
  const notes = await angularNotes(pluginConfig('@semantic-release/release-notes-generator'), context([fix, feat]));
  assert.doesNotMatch(notes, /BREAKING/);
});

test('the release notes say what a release means for existing files', () => {
  const notes = generateNotes({}, { commits: [
    commit('a', 'fix(runtime): a thing\n\nFiles: no change.'),
    commit('b', 'feat(format): a minor\n\nFiles: optional. skac asset migrate adds a glow.'),
    commit('c', 'docs: words'),
  ] });
  assert.match(notes, /### Existing \.skmotion files/);
  assert.match(notes, /\*\*Optional\.\*\* .*skac asset migrate <file> --dry-run/);
  assert.match(notes, /\* No change: a thing \(aaaaaaa\)/);
  assert.match(notes, /\* Optional: a minor \(bbbbbbb\)\. skac asset migrate adds a glow\./);
  assert.equal(generateNotes({}, { commits: [commit('c', 'docs: words')] }), '');
});

test('the footer is needed on typed commits that touch file reading or writing', () => {
  assert.deepEqual(parseFiles('x\n\nFiles: No change.'), { verdict: 'no change', detail: '' });
  assert.deepEqual(parseFiles('x\n\nFiles: no change.\n\nCo-Authored-By: X <x@example.com>'), { verdict: 'no change', detail: '' }, 'the next line is not the detail');
  assert.equal(parseFiles('x\n\nFiles: no change.\nFiles: required. Run migrate.').verdict, 'required', 'the strictest of several wins');
  assert.equal(parseFiles('x\n\nFiles: maybe'), undefined);
  assert.equal(needsFooter('fix(runtime): x', ['runtime/asset-draw.ts']), true);
  assert.equal(needsFooter('feat: x', ['src/asset.js']), true);
  assert.equal(needsFooter('perf!: x', ['templates/motion/machine.ts']), true);
  assert.equal(needsFooter('docs: x', ['runtime/asset.ts']), false);
  assert.equal(needsFooter('fix: x', ['src/cli.js']), false);
});

test('a typed commit that should state its effect and does not is listed, and the summary never says no step is needed', () => {
  // A hash git cannot read counts as touching the format: the notes say so rather than guess.
  const notes = generateNotes({}, { cwd: process.cwd(), commits: [
    commit('a', 'fix(runtime): a thing\n\nFiles: no change.'),
    commit('d', 'feat(runtime): unstated'),
  ] });
  assert.match(notes, /\*\*Not stated\.\*\*/);
  assert.match(notes, /\* Not stated: unstated \(ddddddd\)/);
  assert.doesNotMatch(notes, /No step is needed/);
});
