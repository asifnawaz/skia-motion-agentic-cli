import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** An error that becomes `{ok:false,error,hint}` and exit code 1. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {string} [hint]
   * @param {Record<string, unknown>} [extra]
   */
  constructor(message, hint, extra) {
    super(message);
    this.hint = hint;
    this.extra = extra || {};
  }
}

/** Throw a CliError. */
export const fail = (message, hint, extra) => {
  throw new CliError(message, hint, extra);
};

/** The one JSON document a command prints. */
export const toJson = (doc) => JSON.stringify(doc, null, 2) + '\n';

/** Document for an error. */
export const errorDoc = (err) => {
  const doc = { ok: false, error: err.message };
  if (err.hint) doc.hint = err.hint;
  return { ...doc, ...(err.extra || {}) };
};

/** Local time with milliseconds, for logs. */
export const now = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(off / 60))}:${p(off % 60)}`
  );
};

export const readText = (path) => readFileSync(path, 'utf8');

/** Run a program and return {code, stdout, stderr}. Never throws on a non-zero exit. */
export const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
};

/** Last `n` lines of a program's output, progress carriage returns turned into newlines. */
export const tail = (r, n = 25) =>
  `${r.stdout}\n${r.stderr}`.replace(/\r/g, '\n').trim().split('\n').slice(-n).join('\n');

/**
 * Round to `d` decimals with ties to even, the way Python's round() behaves on a float.
 * Number.prototype.toFixed is exact on the binary value but sends exact ties up, so ties are caught first.
 * @param {number} x
 * @param {number} [d]
 */
export const round = (x, d = 0) => {
  const exact = x.toFixed(Math.min(100, d + 40));
  const [int, frac = ''] = exact.replace('-', '').split('.');
  const head = frac.slice(0, d);
  const rest = frac.slice(d);
  if (/^50*$/.test(rest)) {
    const lastDigit = Number((d ? head : int).slice(-1));
    const down = Number(`${x < 0 ? '-' : ''}${int}${d ? '.' + head : ''}`);
    const step = x < 0 ? -(10 ** -d) : 10 ** -d;
    return lastDigit % 2 === 0 ? down : Number((down + step).toFixed(d));
  }
  return Number(x.toFixed(d));
};

export const levenshteinNear = (word, list, n = 3) => {
  const score = (a, b) => {
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (b.includes(a) || a.includes(b)) return 0;
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  return list
    .map((x) => [score(word, x), x])
    .filter(([s]) => s <= Math.max(2, Math.floor(word.length / 3)))
    .sort((x, y) => x[0] - y[0])
    .slice(0, n)
    .map(([, x]) => x);
};
