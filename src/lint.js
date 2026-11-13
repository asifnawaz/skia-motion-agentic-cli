// `skac lint`: walks the source with TypeScript's own parser and returns findings in the one shape every layer uses.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fail } from './util.js';
import { LINT_RULES } from './lint-rules.js';

const SEVERITIES = { error: 'error', warn: 'warn', warning: 'warn', off: 'off' };
const SCRIPT_KINDS = { '.tsx': 'TSX', '.ts': 'TS', '.jsx': 'JSX', '.js': 'JS', '.mjs': 'JS', '.cjs': 'JS', '.mts': 'TS', '.cts': 'TS' };
const DISABLE = /\/\/\s*skac-disable-next-line\b(.*)$/;

/** TypeScript from the project, else the one skac was installed with. */
export const loadTypeScript = (cfg) => {
  const tries = [join(cfg.projectDir, 'package.json'), import.meta.url];
  for (const base of tries) {
    try {
      return createRequire(base)('typescript');
    } catch {
      /* try the next */
    }
  }
  return fail('typescript was not found, so skac cannot parse the source (lint and --export need it)', 'run npm install in the project (typescript is a devDependency of the template), then try again');
};

/** Severity for a rule: the config's `rules` map, else the rule's default. */
const severityOf = (id, severities) => {
  const set = severities && severities[id] !== undefined ? SEVERITIES[severities[id]] : undefined;
  if (severities && severities[id] !== undefined && !set) fail(`rule ${id} has the unknown severity "${severities[id]}"`, 'use "error", "warn" or "off"');
  return set ?? LINT_RULES[id].default;
};

/** `// skac-disable-next-line skac/a, skac/b -- reason`, per line. */
const parseDisables = (text) => {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const m = DISABLE.exec(raw);
    if (!m) return;
    const [ids, ...why] = m[1].split(/\s--\s/);
    const reason = why.join(' -- ').trim();
    out.push({
      line: i + 1,
      column: raw.indexOf('//') + 1,
      ids: ids.split(',').map((s) => s.trim()).filter(Boolean),
      reason,
    });
  });
  return out;
};

const lintText = (ts, cfg, filePath, text, severities) => {
  const kind = SCRIPT_KINDS[extname(filePath)] || 'TS';
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind[kind]);
  const ctx = { ts, sf, text, filePath, projectDir: cfg.projectDir };
  const shown = relative(cfg.projectDir, filePath).split('\\').join('/');
  const file = shown.startsWith('..') ? filePath : shown;
  const disables = parseDisables(text);
  const raw = [];

  for (const [id, rule] of Object.entries(LINT_RULES)) {
    const severity = severityOf(id, severities);
    if (severity === 'off') continue;
    for (const hit of rule.check(ctx)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(hit.node.getStart(sf));
      const finding = { ruleId: id, severity, message: hit.message, fix: rule.fix, docs: rule.docs, file, line: line + 1, column: character + 1 };
      if (hit.value !== undefined) finding.value = hit.value;
      raw.push({ finding, edits: hit.edits });
    }
  }

  const findings = [];
  const edits = [];
  for (const { finding, edits: e } of raw) {
    const off = disables.some((d) => d.reason && d.line + 1 === finding.line && d.ids.includes(finding.ruleId));
    if (off) continue;
    findings.push(finding);
    if (e) edits.push(...e);
  }
  const needsReason = severityOf('skac/disable-needs-reason', severities);
  if (needsReason !== 'off') {
    const rule = LINT_RULES['skac/disable-needs-reason'];
    for (const d of disables) {
      if (d.reason) continue;
      findings.push({ ruleId: 'skac/disable-needs-reason', severity: needsReason, message: 'a disable comment without a reason, so it disables nothing', fix: rule.fix, docs: rule.docs, file, line: d.line, column: d.column });
    }
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { findings, edits };
};

/** Apply non-overlapping edits from the end of the text backwards; identical edits count once. */
const applyEdits = (text, edits) => {
  const seen = new Set();
  const list = edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.text}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  list.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let floor = Infinity;
  for (const e of list) {
    if (e.end > floor) continue; // overlaps a later edit: the next pass picks it up
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
};

/**
 * Lint files. Relative paths are taken from the current directory.
 * `severities` is the config's `rules` map (id -> 'error' | 'warn' | 'off'); `fix` rewrites fixable hits in place
 * and returns what is left.
 * @param {{projectDir: string}} cfg
 * @param {string[]} files
 * @param {{fix?: boolean, severities?: Record<string, string>}} [opts]
 * @returns {{findings: object[], fixed: string[]}}
 */
export const lintFiles = (cfg, files, { fix = false, severities = {} } = {}) => {
  const ts = loadTypeScript(cfg);
  const findings = [];
  const fixed = [];
  for (const f of files) {
    const filePath = isAbsolute(f) ? f : resolve(f);
    if (!existsSync(filePath)) fail(`${f} does not exist`, 'pass the path of a .ts or .tsx file');
    let text = readFileSync(filePath, 'utf8');
    let r = lintText(ts, cfg, filePath, text, severities);
    if (fix && r.edits.length) {
      const next = applyEdits(text, r.edits);
      if (next !== text) {
        writeFileSync(filePath, next);
        fixed.push(filePath);
        text = next;
        r = lintText(ts, cfg, filePath, text, severities);
      }
    }
    findings.push(...r.findings);
  }
  return { findings, fixed };
};
