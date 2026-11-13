import { existsSync, readFileSync } from 'node:fs';
import { fail } from './util.js';

/**
 * Parse flags. `--k=v` and `--k v` both work for string flags.
 * @param {string[]} argv
 * @param {{bool?: string[], str?: string[], list?: string[]}} spec
 * @returns {{pos: string[], flags: Record<string, any>}}
 */
export const parseArgs = (argv, spec = {}) => {
  const bool = new Set(spec.bool || []);
  const str = new Set(spec.str || []);
  const list = new Set(spec.list || []);
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
    let val = eq < 0 ? undefined : a.slice(eq + 1);
    if (bool.has(key)) {
      flags[key] = val === undefined ? true : val !== 'false';
    } else if (str.has(key) || list.has(key)) {
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined) fail(`--${key} needs a value`, 'see `skac docs commands`');
      }
      if (list.has(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else {
      fail(`unknown flag --${key}`, 'see `skac docs commands` for every flag');
    }
  }
  return { pos, flags };
};

/**
 * Parse `"tap@4.0 correct@6.5"` into `[{name, at}]` (at in seconds).
 * @param {string} text
 */
export const parseEvents = (text) => {
  const events = [];
  for (const tok of text.trim().split(/[\s,]+/)) {
    if (!tok) continue;
    const m = /^([A-Za-z_][\w-]*)@(\d*\.?\d+)$/.exec(tok);
    if (!m) fail(`bad event ${JSON.stringify(tok)}`, 'use name@seconds, like --commands "tap@4.0 correct@6.5"');
    events.push({ name: m[1], at: Number(m[2]) });
  }
  return events;
};

/**
 * Parse `--commands`: an inline string ("tap@4.0 correct@6.5") or a path to a file, one command per line:
 * `event <name> <seconds>`, `advance <seconds>`, `screenshot` (capture at the current time). `#` starts a comment.
 * @param {string} text inline commands, or a path to a commands file
 * @returns {{events: {name: string, at: number}[], captures: number[]}}
 */
export const parseCommands = (text, readFile = readFileSync, exists = existsSync) => {
  if (!exists(text)) return { events: parseEvents(text), captures: [] };
  const events = [];
  const captures = [];
  let clock = 0;
  readFile(text, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const [verb, a, b] = line.split(/\s+/);
    const secs = (v) => {
      if (!/^\d*\.?\d+$/.test(v || '')) fail(`line ${i + 1}: expected seconds, got ${JSON.stringify(v)}`, 'commands file: event <name> <seconds> | advance <seconds> | screenshot');
      return Number(v);
    };
    if (verb === 'event') {
      if (!a) fail(`line ${i + 1}: event needs a name`, 'event <name> <seconds>');
      events.push({ name: a, at: secs(b) });
    } else if (verb === 'advance') clock += secs(a);
    else if (verb === 'screenshot') captures.push(clock);
    else fail(`line ${i + 1}: unknown command ${JSON.stringify(verb)}`, 'use event, advance or screenshot');
  });
  return { events, captures };
};
