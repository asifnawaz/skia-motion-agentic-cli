#!/usr/bin/env node
/**
 * The "Files:" footer: every feat, fix or perf commit that touches what reads or writes .skmotion files says what it means for files
 * apps already ship. "no change" (they play as before), "optional" (skac asset migrate adds something new) or "required" (a new
 * format major: run skac asset migrate before upgrading the runtime). Agents porting files read it in the release notes.
 *
 * The footer is read here, not by the commit parser: a note keyword there makes commit-analyzer read every footer as a breaking change.
 *
 * As a semantic-release plugin it adds a section to the release notes. Run as
 * `node scripts/files-footer.js <base> <head>` it fails when a commit in base..head needs the footer and lacks it.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERDICTS = ['no change', 'optional', 'required'];
const TYPED = /^(feat|fix|perf)(\([^)]*\))?!?:\s*(.+)$/;
const FILE_PATHS = /^(runtime\/|src\/asset|templates\/motion\/machine)/;

/** The commit's Files verdict and the rest of its line, or undefined when it has none. With several Files lines the strictest wins. */
export function parseFiles(message) {
  let found;
  for (const match of message.matchAll(/^Files:[ \t]*(no change|optional|required)\b[.:,;]?[ \t]*(.*)$/gim)) {
    const next = { verdict: match[1].toLowerCase(), detail: match[2].trim() };
    if (!found || VERDICTS.indexOf(next.verdict) > VERDICTS.indexOf(found.verdict)) found = next;
  }
  return found;
}

/** True when a commit with this subject touching these paths must carry the footer. */
export function needsFooter(subject, paths) {
  return TYPED.test(subject) && paths.some((path) => FILE_PATHS.test(path));
}

const HEADINGS = { required: 'Required', optional: 'Optional', 'no change': 'No change', unknown: 'Not stated' };
const ORDER = ['no change', 'optional', 'unknown', 'required'];

function changedPaths(hash, cwd) {
  try {
    return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', hash], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * semantic-release: the "Existing .skmotion files" section of the release notes. A commit that should state its effect and does not
 * (it reached main without the pull request check) is listed as not stated, and the summary never claims that no step is needed then.
 */
export function generateNotes(_config, { commits, cwd }) {
  const rows = [];
  for (const commit of commits) {
    const subject = commit.message.split('\n')[0];
    const typed = TYPED.exec(subject);
    if (!typed) continue;
    const files = parseFiles(commit.message);
    const hash = commit.hash.slice(0, 7);
    if (files) rows.push({ ...files, subject: typed[3], hash });
    else {
      const paths = changedPaths(commit.hash, cwd);
      if (!paths || needsFooter(subject, paths)) rows.push({ verdict: 'unknown', detail: '', subject: typed[3], hash });
    }
  }
  if (!rows.length) return '';
  const worst = ORDER.slice().reverse().find((verdict) => rows.some((row) => row.verdict === verdict));
  const summary = {
    'no change': 'Existing files play as before. No step is needed.',
    optional: 'Existing files play as before. Run skac asset migrate <file> --dry-run to see what a file can gain.',
    unknown: 'A change below does not say what it means for existing files: run skac asset check on each file, and skac asset migrate <file> --dry-run, before upgrading.',
    required: 'Run skac asset migrate <file> on every file before upgrading the app\'s runtime.',
  }[worst];
  const lines = ['### Existing .skmotion files', '', `**${HEADINGS[worst]}.** ${summary}`, ''];
  for (const row of rows) lines.push(`* ${HEADINGS[row.verdict]}: ${row.subject} (${row.hash})${row.detail ? `. ${row.detail}` : ''}`);
  return lines.join('\n');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The commits in base..head that need the footer and lack it. */
export function missingFooters(base, head) {
  const hashes = git(['rev-list', '--no-merges', `${base}..${head}`]).split('\n').filter(Boolean);
  return hashes.flatMap((hash) => {
    const message = git(['log', '-1', '--format=%B', hash]);
    const paths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', hash]).split('\n').filter(Boolean);
    return needsFooter(message.split('\n')[0], paths) && !parseFiles(message) ? [`${hash.slice(0, 7)} ${message.split('\n')[0]}`] : [];
  });
}

// Compare real paths: started through a symlinked folder, argv[1] keeps the link while import.meta.url has the target.
const started = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (started) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) {
    console.error('usage: node scripts/files-footer.js <base> [head]');
    process.exit(2);
  }
  const missing = missingFooters(base, head);
  if (missing.length) {
    console.error(`These commits change how .skmotion files are read or written and need a footer line, one of:
  Files: no change.
  Files: optional. <what skac asset migrate adds>
  Files: required. <why files need skac asset migrate>
${missing.map((line) => `  ${line}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Every commit that touches .skmotion reading or writing says what it means for existing files.');
}
