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

/** A value as a command writes it: true, false, a number, or else a string (an enum option). */
const literal = (v) => {
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { fail(`bad quoted value ${v}`, 'use a JSON string, like "true"'); }
  }
  return v === 'true' ? true : v === 'false' ? false : /^-?\d*\.?\d+$/.test(v) ? Number(v) : v;
};

/**
 * Parse inline events into `[{name, at}]` (at in seconds): `tap@4.0` fires a trigger (or names an event), `level=0.5@1`
 * writes a machine value, and `tap:120,60@1.5` taps the point (120, 60) in pt, hit-testing the machine's part boxes.
 * @param {string} text
 */
export const parseEvents = (text) => {
  const events = [];
  // Tokens part at spaces or commas; the comma inside tap:x,y is kept by marking it first.
  const marked = text.trim().replace(/(tap:-?\d*\.?\d+),(-?\d*\.?\d+@)/g, '$1\u0001$2');
  for (const raw of marked.split(/[\s,]+/)) {
    const tok = raw.replace('\u0001', ',');
    if (!tok) continue;
    let m = /^([A-Za-z_][\w-]*)@(\d*\.?\d+)$/.exec(tok);
    if (m) { events.push({ name: m[1], at: Number(m[2]) }); continue; }
    m = /^([A-Za-z_][\w-]*)=([^@\s]+)@(\d*\.?\d+)$/.exec(tok);
    if (m) { events.push({ name: m[1], to: literal(m[2]), at: Number(m[3]) }); continue; }
    m = /^(tap):(-?\d*\.?\d+),(-?\d*\.?\d+)@(\d*\.?\d+)$/.exec(tok);
    if (m) { events.push({ pointer: m[1], x: Number(m[2]), y: Number(m[3]), at: Number(m[4]) }); continue; }
    fail(`bad event ${JSON.stringify(tok)}`, 'use name@seconds (tap@4.0), value=v@seconds (live=true@0.3) or tap:x,y@seconds (tap:120,60@1.5)');
  }
  return events;
};

/**
 * Parse `--commands`: an inline string ("tap@4.0 correct@6.5") or a path to a file, one command per line:
 * `event <name> <seconds>`, `advance <seconds>`, `screenshot` (capture at the current time), and for a machine scene
 * `set <value> <v> <seconds>`, `trigger <name> <seconds>` and `pointer tap@x,y <seconds>`. `#` starts a comment.
 * @param {string} text inline commands, or a path to a commands file
 * @returns {{events: {name?: string, to?: unknown, pointer?: string, x?: number, y?: number, at: number}[], captures: number[]}}
 */
export const parseCommands = (text, readFile = readFileSync, exists = existsSync) => {
  if (!exists(text)) return { events: parseEvents(text), captures: [] };
  const events = [];
  const captures = [];
  let clock = 0;
  readFile(text, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const [verb, a, b, c] = line.split(/\s+/);
    const secs = (v) => {
      if (!/^\d*\.?\d+$/.test(v || '')) fail(`line ${i + 1}: expected seconds, got ${JSON.stringify(v)}`, 'commands file: event <name> <seconds> | advance <seconds> | screenshot');
      return Number(v);
    };
    if (verb === 'event') {
      if (!a) fail(`line ${i + 1}: event needs a name`, 'event <name> <seconds>');
      events.push({ name: a, at: secs(b) });
    } else if (verb === 'trigger') {
      if (!a) fail(`line ${i + 1}: trigger needs a name`, 'trigger <name> <seconds>');
      events.push({ name: a, at: secs(b) });
    } else if (verb === 'set') {
      if (!a || b === undefined) fail(`line ${i + 1}: set needs a value name and a value`, 'set <value> <true|false|number|option> <seconds>');
      events.push({ name: a, to: literal(b), at: secs(c) });
    } else if (verb === 'pointer') {
      const p = /^(tap)@(-?\d*\.?\d+),(-?\d*\.?\d+)$/.exec(a || '');
      if (!p) fail(`line ${i + 1}: expected tap@x,y, got ${JSON.stringify(a)}`, 'pointer tap@<x>,<y> <seconds>, x and y in pt');
      events.push({ pointer: p[1], x: Number(p[2]), y: Number(p[3]), at: secs(b) });
    } else if (verb === 'advance') clock += secs(a);
    else if (verb === 'screenshot') captures.push(clock);
    else fail(`line ${i + 1}: unknown command ${JSON.stringify(verb)}`, 'use event, set, trigger, pointer, advance or screenshot');
  });
  return { events, captures };
};
