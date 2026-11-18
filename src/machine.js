import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleModule } from './rig.js';
import { fail } from './util.js';

/**
 * `<Name>.machine.json`, format `skac.machine/1`: typed bound values, optional named clocks, layers of states that
 * play clips, transitions with conditions, actions that set values, and hit areas on part boxes (skac docs machine).
 * This file reads and judges the file for the CLI; runtime/core.ts runs it.
 */

export const SCHEMA = 'skac.machine/1';
export const VALUE_TYPES = ['boolean', 'number', 'enum', 'trigger'];
export const BINDS = ['in', 'out', 'both'];
export const LOOPS = ['once', 'loop', 'pingpong'];
export const EASES = ['linear', 'out', 'inOut', 'in'];
export const OPS = ['==', '!=', '<', '<=', '>', '>='];
export const HIT_KINDS = ['tap']; // down and up wait for a gesture model in both runtimes (M2)
/** Rive's cap, kept: a layer changes state at most this often in one instant (rive-runtime state_machine_instance.cpp). */
export const MAX_CHANGES = 100;

const KEYS = {
  root: ['schema', 'values', 'clocks', 'layers', 'hits'],
  value: ['type', 'default', 'options', 'bind'],
  clock: ['wrap_ms', 'step_hz'],
  layer: ['name', 'entry', 'clock', 'states', 'transitions'],
  state: ['clip', 'loop', 'speed', 'blend', 'reason', 'on_enter', 'on_exit'],
  blend: ['by', 'keys'],
  transition: ['from', 'to', 'when', 'exit_at', 'duration_ms', 'ease', 'on_start', 'on_end'],
  entry: ['to', 'when'],
  action: ['set', 'to', 'fire'],
  hit: ['part', 'on', 'set', 'to', 'fire'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeOfLiteral = (v) => (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' && Number.isFinite(v) ? 'number' : typeof v === 'string' ? 'string' : null);

/**
 * Judge a parsed machine. Returns `{problems, warnings}`: each `{where, error, hint}`. `clipNames`, when given, are the
 * clips `<Name>.clips.ts` exports; with `clips` their lengths are also checked against wrapping clocks.
 * @param {unknown} m
 * @param {{clips?: Record<string, {ms: number}>, clipNames?: string[]}} [opts]
 */
export const validateMachine = (m, { clips, clipNames = clips && Object.keys(clips) } = {}) => {
  const problems = [];
  const warnings = [];
  const bad = (where, error, hint) => problems.push({ where, error, hint });
  const unknownKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) bad(where, `unknown key "${k}"`, `allowed here: ${allowed.join(', ')}. A newer skac may know it: check \`skac --version\``);
    }
  };

  if (!isObj(m)) {
    bad('', 'the machine is not a JSON object', `start from {"schema":"${SCHEMA}","values":{},"layers":[]}`);
    return { problems, warnings };
  }
  unknownKeys(m, KEYS.root, '');
  if (m.schema !== SCHEMA) {
    const major = typeof m.schema === 'string' && m.schema.startsWith('skac.machine/') ? m.schema : null;
    bad('schema', `schema is ${JSON.stringify(m.schema)}`, major ? `this skac reads ${SCHEMA}; update skac to read ${major}` : `set "schema": "${SCHEMA}"`);
  }

  // Values.
  const values = isObj(m.values) ? m.values : {};
  if (m.values !== undefined && !isObj(m.values)) bad('values', 'values is not an object', 'like "values": {"live": {"type": "boolean"}}');
  for (const [name, v] of Object.entries(values)) {
    const where = `values.${name}`;
    if (!isObj(v)) { bad(where, 'a value is not an object', 'like {"type": "boolean", "default": false}'); continue; }
    unknownKeys(v, KEYS.value, where);
    if (!VALUE_TYPES.includes(v.type)) { bad(where, `type ${JSON.stringify(v.type)} is not one of ${VALUE_TYPES.join(', ')}`, 'string, colour, image and list values are not in skac.machine/1'); continue; }
    if (v.bind !== undefined && !BINDS.includes(v.bind)) bad(where, `bind ${JSON.stringify(v.bind)} is not one of ${BINDS.join(', ')}`, '"in": the app writes it; "out": the machine writes it and the app reads it; "both"');
    if (v.type === 'enum') {
      if (!Array.isArray(v.options) || v.options.length < 2 || !v.options.every((o) => typeof o === 'string')) {
        bad(where, 'an enum needs "options", two or more strings', 'like "options": ["idle", "happy", "sad"]');
      } else if (new Set(v.options).size !== v.options.length) bad(where, 'enum options repeat', 'name each option once');
    } else if (v.options !== undefined) bad(where, `"options" belongs to an enum, not a ${v.type}`, 'remove "options"');
    if (v.type === 'trigger') {
      if (v.default !== undefined) bad(where, 'a trigger has no default', 'remove "default": a trigger is fired, never held');
    } else if (v.default !== undefined) {
      const want = v.type === 'enum' ? 'string' : v.type;
      if (typeOfLiteral(v.default) !== want) bad(where, `default ${JSON.stringify(v.default)} is not a ${v.type}`, `give a ${v.type} default`);
      else if (v.type === 'enum' && Array.isArray(v.options) && !v.options.includes(v.default)) bad(where, `default "${v.default}" is not an option`, `pick one of ${v.options.join(', ')}`);
    }
  }
  const valueType = (n) => (isObj(values[n]) ? values[n].type : undefined);

  // Clocks.
  const clocks = isObj(m.clocks) ? m.clocks : {};
  if (m.clocks !== undefined && !isObj(m.clocks)) bad('clocks', 'clocks is not an object', 'like "clocks": {"ambient": {"wrap_ms": 64000, "step_hz": 30}}');
  for (const [name, c] of Object.entries(clocks)) {
    const where = `clocks.${name}`;
    if (!isObj(c)) { bad(where, 'a clock is not an object', 'like {"wrap_ms": 64000, "step_hz": 30}'); continue; }
    unknownKeys(c, KEYS.clock, where);
    if (c.wrap_ms !== undefined && !(typeof c.wrap_ms === 'number' && c.wrap_ms > 0)) bad(where, 'wrap_ms is not a positive number', 'the length in ms after which the clock starts again, or leave it out');
    if (!(typeof c.step_hz === 'number' && c.step_hz > 0 && c.step_hz <= 240)) bad(where, 'step_hz is not a rate from 1 to 240', 'how often the app steps this clock, like 30; the CLI simulates it at that rate');
  }

  // A literal or a value name on the right of a condition or action, checked against the type it must have.
  const operand = (rhs, type, where, options, assignment = false) => {
    const enumOptions = type === 'enum' && Array.isArray(options) ? options : undefined;
    if (typeof rhs === 'string' && values[rhs] !== undefined && !enumOptions?.includes(rhs)) {
      if (valueType(rhs) !== type) bad(where, `"${rhs}" is a ${valueType(rhs)}, compared with a ${type}`, 'compare values of one type');
      else if (assignment && enumOptions && Array.isArray(values[rhs].options)) {
        const missing = values[rhs].options.filter((option) => !enumOptions.includes(option));
        if (missing.length) bad(where, `enum "${rhs}" can write undeclared options: ${missing.join(', ')}`, 'use an enum with only options the destination declares');
      }
      return;
    }
    const want = type === 'enum' ? 'string' : type;
    if (typeOfLiteral(rhs) !== want) bad(where, `${JSON.stringify(rhs)} is not a ${type} or the name of a value`, `give a ${type}`);
    else if (enumOptions && !enumOptions.includes(rhs)) bad(where, `"${rhs}" is not an option of the enum`, `pick one of ${enumOptions.join(', ')}`);
  };

  const conditions = (when, where) => {
    if (when === undefined) return [];
    if (!Array.isArray(when)) { bad(where, '"when" is not a list', 'like "when": [["live", "==", true]]'); return []; }
    const triggers = [];
    when.forEach((c, i) => {
      const w = `${where}[${i}]`;
      if (!Array.isArray(c) || (c.length !== 1 && c.length !== 3)) { bad(w, 'a condition is not [value] or [value, op, operand]', 'like ["live", "==", true], or ["tap"] for a trigger'); return; }
      const [lhs, op, rhs] = c;
      const t = valueType(lhs);
      if (!t) { bad(w, `no value named ${JSON.stringify(lhs)}`, `declare it under "values"`); return; }
      if (c.length === 1) {
        if (t !== 'trigger') bad(w, `["${lhs}"] alone works for a trigger, and ${lhs} is a ${t}`, `like ["${lhs}", "==", ${t === 'boolean' ? 'true' : '…'}]`);
        else triggers.push(lhs);
        return;
      }
      if (t === 'trigger') { bad(w, `${lhs} is a trigger: write ["${lhs}"]`, 'a trigger is true for the one instant it fires'); return; }
      if (!OPS.includes(op)) { bad(w, `operator ${JSON.stringify(op)} is not one of ${OPS.join(' ')}`, 'use one of them'); return; }
      if (t !== 'number' && !['==', '!='].includes(op)) bad(w, `${op} compares numbers, and ${lhs} is a ${t}`, 'use == or !=');
      operand(rhs, t, w, values[lhs].options);
    });
    return triggers;
  };

  const actions = (list, where) => {
    if (list === undefined) return;
    if (!Array.isArray(list)) { bad(where, 'actions are not a list', 'like [{"set": "mood", "to": "happy"}]'); return; }
    list.forEach((a, i) => {
      const w = `${where}[${i}]`;
      if (!isObj(a)) { bad(w, 'an action is not an object', 'like {"set": "mood", "to": "happy"} or {"fire": "done"}'); return; }
      unknownKeys(a, KEYS.action, w);
      if (a.fire !== undefined) {
        if (a.set !== undefined || a.to !== undefined) bad(w, 'an action either sets or fires', 'split it into two actions');
        if (valueType(a.fire) !== 'trigger') bad(w, `"${a.fire}" is not a trigger`, 'fire a trigger value; set the others');
        return;
      }
      const t = valueType(a.set);
      if (!t) { bad(w, `no value named ${JSON.stringify(a.set)}`, 'declare it under "values"'); return; }
      if (t === 'trigger') { bad(w, `"${a.set}" is a trigger`, `write {"fire": "${a.set}"}`); return; }
      if (a.to === undefined) { bad(w, 'a set action has no "to"', 'give the new value'); return; }
      operand(a.to, t, w, values[a.set].options, true);
    });
  };

  // Layers.
  if (!Array.isArray(m.layers) || m.layers.length === 0) bad('layers', 'there are no layers', 'add {"name": "main", "entry": "idle", "states": {"idle": {"clip": "idle"}}}');
  const layers = Array.isArray(m.layers) ? m.layers : [];
  const layerNames = new Set();
  const graphs = [];
  layers.forEach((L, li) => {
    const lw = `layers[${li}]`;
    if (!isObj(L)) { bad(lw, 'a layer is not an object', 'like {"name": "main", "entry": "idle", "states": {...}}'); return; }
    unknownKeys(L, KEYS.layer, lw);
    if (typeof L.name !== 'string' || !L.name) bad(lw, 'a layer has no name', 'name it');
    else if (layerNames.has(L.name)) bad(lw, `layer name "${L.name}" repeats`, 'name each layer once');
    else layerNames.add(L.name);
    const where = typeof L.name === 'string' && L.name ? `layers.${L.name}` : lw;
    if (L.clock !== undefined && !isObj(clocks[L.clock])) bad(`${where}.clock`, `no clock named ${JSON.stringify(L.clock)}`, 'declare it under "clocks", or leave "clock" out for the frame clock');
    const wrap = typeof L.clock === 'string' ? clocks[L.clock]?.wrap_ms : undefined;
    const states = isObj(L.states) ? L.states : {};
    const names = Object.keys(states);
    if (!names.length) bad(`${where}.states`, 'the layer has no states', 'add one: "idle": {"clip": "idle"}');
    if (names.includes('exit') || names.includes('*')) bad(`${where}.states`, '"exit" and "*" are reserved', 'rename the state');
    for (const [sn, s] of Object.entries(states)) {
      const sw = `${where}.states.${sn}`;
      if (!isObj(s)) { bad(sw, 'a state is not an object', 'like {"clip": "idle", "loop": "loop"}'); continue; }
      unknownKeys(s, KEYS.state, sw);
      if (s.clip !== undefined && s.blend !== undefined) bad(sw, 'a state plays a clip or a blend, not both', 'keep one');
      if (s.clip !== undefined) {
        if (typeof s.clip !== 'string') bad(sw, 'clip is not a name', 'the name of a clip in <Name>.clips.ts');
        else if (clipNames && !clipNames.includes(s.clip)) bad(sw, `no clip named "${s.clip}"`, clipNames.length ? `clips: ${clipNames.join(', ')}` : 'export it from <Name>.clips.ts');
      }
      if (s.loop !== undefined && !LOOPS.includes(s.loop)) bad(sw, `loop ${JSON.stringify(s.loop)} is not one of ${LOOPS.join(', ')}`, 'once plays and holds its last frame');
      if (s.speed !== undefined && !(typeof s.speed === 'number' && s.speed > 0)) bad(sw, 'speed is not a positive number', '1 is normal speed; play a reversed clip for backward');
      if (s.reason !== undefined && typeof s.reason !== 'string') bad(sw, 'reason is not text', 'say why this loop may keep the screen drawing');
      const checkPeriod = (clip, where) => {
        if (!clipNames?.includes(clip) || !Number.isFinite(wrap) || wrap <= 0 || (s.loop !== 'loop' && s.loop !== 'pingpong')) return;
        const period = clips?.[clip]?.ms * (s.loop === 'pingpong' ? 2 : 1) / (s.speed ?? 1);
        if (!Number.isFinite(period) || period <= 0) return;
        const laps = Math.max(1, Math.round(wrap / period));
        if (Math.abs(wrap - laps * period) > 1e-6) {
          warnings.push({ where, error: `clip "${clip}" has a ${period} ms period that does not divide ${L.clock}.wrap_ms (${wrap} ms)`,
            hint: 'use a period that fits a whole number of times in the clock wrap' });
        }
      };
      if (typeof s.clip === 'string') checkPeriod(s.clip, sw);
      if (s.blend !== undefined) {
        const b = s.blend;
        if (!isObj(b)) bad(sw, 'blend is not an object', 'like {"by": "level", "keys": [[0, "empty"], [1, "full"]]}');
        else {
          unknownKeys(b, KEYS.blend, `${sw}.blend`);
          if (valueType(b.by) !== 'number') bad(`${sw}.blend`, `blend "by" ${JSON.stringify(b.by)} is not a number value`, 'a 1D blend follows one number value');
          const keys = Array.isArray(b.keys) ? b.keys : [];
          if (keys.length < 2 || !keys.every((k) => Array.isArray(k) && k.length === 2 && typeof k[0] === 'number' && typeof k[1] === 'string')) {
            bad(`${sw}.blend`, 'keys are not two or more [number, clip] pairs', 'like [[0, "empty"], [1, "full"]]');
          } else {
            for (let i = 1; i < keys.length; i++) if (!(keys[i][0] > keys[i - 1][0])) bad(`${sw}.blend`, 'key values do not rise', 'order the keys by their numbers, each above the last');
            if (clipNames) for (const [, c] of keys) {
              if (!clipNames.includes(c)) bad(`${sw}.blend`, `no clip named "${c}"`, `clips: ${clipNames.join(', ')}`);
              else checkPeriod(c, `${sw}.blend`);
            }
          }
        }
      }
      actions(s.on_enter, `${sw}.on_enter`);
      actions(s.on_exit, `${sw}.on_exit`);
    }

    // Entry: a state name, or a list of {to, when} where the last has no condition.
    const entryTargets = [];
    if (typeof L.entry === 'string') entryTargets.push(L.entry);
    else if (Array.isArray(L.entry) && L.entry.length) {
      L.entry.forEach((e, i) => {
        const ew = `${where}.entry[${i}]`;
        if (!isObj(e)) { bad(ew, 'an entry branch is not an object', 'like {"to": "on", "when": [["on", "==", true]]}'); return; }
        unknownKeys(e, KEYS.entry, ew);
        entryTargets.push(e.to);
        conditions(e.when, `${ew}.when`);
        if (i === L.entry.length - 1 && e.when !== undefined) bad(ew, 'the last entry branch has a condition', 'end with {"to": "<state>"} so the layer always starts somewhere');
      });
    } else bad(`${where}.entry`, 'the layer has no entry', `like "entry": "${names[0] || 'idle'}"`);
    for (const t of entryTargets) if (!names.includes(t)) bad(`${where}.entry`, `entry goes to "${t}", which is not a state`, `states: ${names.join(', ')}`);

    // Transitions.
    const edges = []; // {from, to, instant, triggers}
    const setsOf = (list) => (Array.isArray(list) ? list : []).map((a) => (isObj(a) ? a.set ?? a.fire : undefined)).filter((n) => typeof n === 'string');
    const exitWrites = new Map(names.map((n) => [n, setsOf(states[n]?.on_exit)]));
    const transitions = Array.isArray(L.transitions) ? L.transitions : [];
    if (L.transitions !== undefined && !Array.isArray(L.transitions)) bad(`${where}.transitions`, 'transitions are not a list', 'like [{"from": "idle", "to": "hop", "when": [["tap"]]}]');
    transitions.forEach((t, ti) => {
      const tw = `${where}.transitions[${ti}]`;
      if (!isObj(t)) { bad(tw, 'a transition is not an object', 'like {"from": "idle", "to": "hop", "when": [["tap"]]}'); return; }
      unknownKeys(t, KEYS.transition, tw);
      if (t.from !== '*' && !names.includes(t.from)) bad(tw, `from "${t.from}" is not a state`, `use a state or "*" (any state): ${names.join(', ')}`);
      if (t.to !== 'exit' && !names.includes(t.to)) bad(tw, `to "${t.to}" is not a state`, `use a state or "exit": ${names.join(', ')}`);
      const triggers = conditions(t.when, `${tw}.when`);
      if (t.exit_at !== undefined) {
        if (!(typeof t.exit_at === 'number' && t.exit_at > 0)) bad(tw, 'exit_at is not a positive share of the clip', '1 waits for the whole clip; 2 for two laps of a loop');
        if (L.clock !== undefined) bad(tw, 'exit_at on a layer that runs on a named clock', 'the app steps that clock, so its exit times are not known ahead; use a condition, or move the state to a frame-clock layer');
      }
      const noCondition = !Array.isArray(t.when) || t.when.length === 0;
      if (noCondition && t.exit_at === undefined) bad(tw, 'the transition has no condition and no exit_at, so it fires the instant it is reached', 'add "exit_at": 1 to play the clip first, or a condition');
      if (t.duration_ms !== undefined && !(typeof t.duration_ms === 'number' && t.duration_ms >= 0)) bad(tw, 'duration_ms is not a number of ms', 'like 200; 0 cuts');
      if (t.ease !== undefined && !EASES.includes(t.ease)) bad(tw, `ease ${JSON.stringify(t.ease)} is not one of ${EASES.join(', ')}`, 'out suits most UI');
      if (t.to === 'exit' && t.duration_ms) bad(tw, 'a transition to exit has no mix', 'remove duration_ms: the layer holds its pose');
      actions(t.on_start, `${tw}.on_start`);
      actions(t.on_end, `${tw}.on_end`);
      const writes = [...setsOf(t.on_start), ...setsOf(t.on_end), ...setsOf(states[t.to]?.on_enter)];
      edges.push({ from: t.from, to: t.to, instant: t.exit_at === undefined && !t.duration_ms, triggers, when: Array.isArray(t.when) ? t.when : [], writes });
    });
    graphs.push({ name: L.name, where, names, entryTargets, edges, states, exitWrites });
  });

  // Hits.
  if (m.hits !== undefined && !Array.isArray(m.hits)) bad('hits', 'hits are not a list', 'like [{"part": "button", "on": "tap", "fire": "tap"}]');
  (Array.isArray(m.hits) ? m.hits : []).forEach((h, i) => {
    const hw = `hits[${i}]`;
    if (!isObj(h)) { bad(hw, 'a hit is not an object', 'like {"part": "button", "on": "tap", "fire": "tap"}'); return; }
    unknownKeys(h, KEYS.hit, hw);
    if (typeof h.part !== 'string' || !h.part) bad(hw, 'a hit has no part', 'name a part box the clips return');
    if (!HIT_KINDS.includes(h.on)) bad(hw, `on ${JSON.stringify(h.on)} is not one of ${HIT_KINDS.join(', ')}`, 'tap is a press and release on the part; down and up are not played yet');
    actions([{ ...(h.set !== undefined ? { set: h.set, to: h.to } : {}), ...(h.fire !== undefined ? { fire: h.fire } : {}) }], hw);
    if (h.set === undefined && h.fire === undefined) bad(hw, 'a hit neither sets nor fires', 'add "fire": "<trigger>" or "set" and "to"');
  });

  // A string operand names a value unless it is an option of the enum it is compared with, as compile reads it.
  const vals = isObj(m.values) ? m.values : {};
  const isRef = (owner, x) => typeof x === 'string' && x in vals && !((isObj(vals[owner]) && Array.isArray(vals[owner].options)) ? vals[owner].options : []).includes(x);
  if (!problems.length) for (const g of graphs) analyse(g, warnings, problems, isRef);
  return { problems, warnings, graphs };
};

/** Two conditions on one value that cannot both hold, for literal operands; an operand naming a value proves nothing. */
const contradicts = (a, b, isRef) => {
  if (a.length !== 3 || b.length !== 3 || a[0] !== b[0]) return false;
  const [, oa, va] = a;
  const [, ob, vb] = b;
  if (isRef(a[0], va) || isRef(b[0], vb)) return false;
  if (typeof va !== typeof vb) return false;
  if (oa === '==' && ob === '==') return va !== vb;
  if ((oa === '==' && ob === '!=') || (oa === '!=' && ob === '==')) return va === vb;
  if (typeof va === 'number') {
    const lo = (op, v) => (op === '>' ? [v, true] : op === '>=' ? [v, false] : op === '==' ? [v, false] : [-Infinity, false]);
    const hi = (op, v) => (op === '<' ? [v, true] : op === '<=' ? [v, false] : op === '==' ? [v, false] : [Infinity, false]);
    const [l1, lx1] = lo(oa, va); const [l2, lx2] = lo(ob, vb);
    const [h1, hx1] = hi(oa, va); const [h2, hx2] = hi(ob, vb);
    const l = l1 > l2 ? [l1, lx1] : l2 > l1 ? [l2, lx2] : [l1, lx1 || lx2];
    const h = h1 < h2 ? [h1, hx1] : h2 < h1 ? [h2, hx2] : [h1, hx1 || hx2];
    return l[0] > h[0] || (l[0] === h[0] && (l[1] || h[1]));
  }
  return false;
};

/** Assign each state to a strongly connected component of the instant-transition graph. */
const componentsOf = (out) => {
  const index = new Map();
  const component = new Map();
  const pending = [];
  const visit = (state) => {
    const id = index.size;
    index.set(state, id);
    pending.push(state);
    let low = id;
    for (const { to } of out.get(state)) {
      if (!index.has(to)) low = Math.min(low, visit(to));
      else if (!component.has(to)) low = Math.min(low, index.get(to));
    }
    if (low === id) {
      let member;
      do { member = pending.pop(); component.set(member, id); } while (member !== state);
    }
    return low;
  };
  for (const state of out.keys()) if (!index.has(state)) visit(state);
  return component;
};

/**
 * Reachable states, dead ends and zero-time cycles of one layer. A zero-time cycle is a loop of transitions that take
 * no time (no exit_at, no mix) and read no trigger, whose conditions can hold in sequence. A trigger breaks a cycle,
 * since a layer takes each trigger once per instant.
 */
const analyse = (g, warnings, problems, isRef) => {
  const any = g.edges.filter((e) => e.from === '*');
  const reach = new Set();
  const stack = [...g.entryTargets];
  while (stack.length) {
    const s = stack.pop();
    if (reach.has(s) || s === 'exit') continue;
    reach.add(s);
    for (const e of g.edges) if ((e.from === s || e.from === '*') && !reach.has(e.to)) stack.push(e.to);
  }
  g.reachable = g.names.filter((n) => reach.has(n));
  g.unreachable = g.names.filter((n) => !reach.has(n));
  for (const n of g.unreachable) {
    problems.push({ where: `${g.where}.states.${n}`, error: `state "${n}" is never reached`, hint: 'add a transition to it, or remove it' });
  }
  g.deadEnds = g.reachable.filter((n) => !any.length && !g.edges.some((e) => e.from === n));
  for (const n of g.deadEnds) {
    warnings.push({ where: `${g.where}.states.${n}`, error: `state "${n}" has no way out`, hint: 'fine for a final state; otherwise add a transition, or an any-state ("*") one' });
  }
  const out = new Map(g.reachable.map((s) => [s, []]));
  g.edges.forEach((e, id) => {
    if (!e.instant || e.triggers.length || !out.has(e.to)) return;
    const sources = e.from === '*' ? g.reachable.filter((s) => s !== e.to) : [e.from];
    for (const from of sources) out.get(from)?.push({ ...e, id, from, writes: [...e.writes, ...g.exitWrites.get(from)] });
  });
  const component = componentsOf(out);
  for (const [from, edges] of out) out.set(from, edges.filter((e) => component.get(from) === component.get(e.to)));
  const cycles = [];
  const seen = new Set();
  const walk = (start, s, path, known) => {
    for (const e of out.get(s)) {
      const conds = [...known, ...e.when];
      if (conds.some((a, i) => conds.slice(i + 1).some((b) => contradicts(a, b, isRef)))) continue;
      const loop = [...path, e];
      if (e.to === start) {
        const key = JSON.stringify(loop.map((p) => JSON.stringify([p.from, p.id])).sort());
        if (!seen.has(key)) {
          seen.add(key);
          // An action on the loop that writes a value its conditions read can end it, or start it: then it is a warning.
          const read = new Set(loop.flatMap((p) => p.when.flatMap((c) => [c[0], ...(isRef(c[0], c[2]) ? [c[2]] : [])])));
          cycles.push({ states: [start, ...loop.map((p) => p.to)], uncertain: loop.some((p) => p.writes.some((w) => read.has(w))) });
        }
      } else if (!path.some((p) => p.to === e.to)) {
        // Once an edge writes a value, earlier guards on that value no longer constrain later guards.
        walk(start, e.to, loop, conds.filter((c) => !e.writes.includes(c[0])));
      }
    }
  };
  for (const n of g.reachable) walk(n, n, [], []);
  g.zeroTimeCycles = cycles.filter((c) => !c.uncertain).map((c) => c.states);
  for (const c of cycles) {
    const entry = { where: `${g.where}.transitions`, error: `states ${c.states.join(' -> ')} can loop with no time passing`,
      hint: 'make the conditions exclusive, read a trigger, or give one transition an exit_at or a duration_ms' };
    if (c.uncertain) {
      warnings.push({ ...entry, error: `${entry.error}, depending on actions that write values read by its conditions`,
        hint: `check it with --trace; the runtime stops a layer at ${MAX_CHANGES} changes in one instant` });
    } else problems.push(entry);
  }
};

/** Where the machine file of `name` lives: beside Root.tsx or in <project>/src, as the rig does. */
export const machineFile = (cfg, name) =>
  [dirname(cfg.root), join(cfg.projectDir, 'src')].map((d) => join(d, `${name}.machine.json`)).find(existsSync);

/** Where `<Name>.clips.ts` lives, beside the machine file's folders. */
export const clipsFile = (cfg, name) =>
  [dirname(cfg.root), join(cfg.projectDir, 'src')].flatMap((d) => ['ts', 'tsx'].map((e) => join(d, `${name}.clips.${e}`))).find(existsSync);

/**
 * Bundle and import `<Name>.clips.ts`: it exports `clips`, each `{ms, play(localMs) => {channels, parts?}}`.
 * Returns null when there is no clips file.
 */
export const loadClips = (cfg, name) => {
  const file = clipsFile(cfg, name);
  if (!file) return null;
  const mod = bundleModule(cfg, file, `${name}.clips.cjs`);
  const clips = mod.clips;
  if (!isObj(clips)) fail(`${file} does not export clips`, 'export const clips = { idle: { ms: 1000, play(ms) { \'worklet\'; return { channels: {...} }; } } }');
  for (const [n, c] of Object.entries(clips)) {
    if (!isObj(c) || typeof c.play !== 'function' || !(typeof c.ms === 'number' && c.ms > 0)) {
      fail(`clip "${n}" in ${file} is not {ms, play}`, 'each clip is { ms: <length in ms>, play(localMs) { \'worklet\'; return { channels } } }');
    }
  }
  return { file, clips };
};

/** Read and parse `<Name>.machine.json`, failing with a hint when it is missing or not JSON. */
export const readMachine = (file) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(`cannot read ${file}`, 'check the path');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${file} is not JSON: ${e.message}`, 'fix the syntax; every key and string takes double quotes');
  }
};

/**
 * `<Name> --machine`: the machine judged and its graph per layer, as one document. `ok` is false when any problem is
 * found; warnings do not change `ok`.
 * @param {*} cfg
 * @param {string} name
 * @param {{clips?: Record<string, {ms: number}>, clipNames?: string[]}} [opts]
 */
export const machineCommand = (cfg, name, { clips, clipNames = clips && Object.keys(clips) } = {}) => {
  const file = machineFile(cfg, name);
  if (!file) fail(`no ${name}.machine.json`, `write src/${name}.machine.json with "schema": "${SCHEMA}" (skac docs machine)`);
  const m = readMachine(file);
  const { problems, warnings, graphs = [] } = validateMachine(m, { clips, clipNames });
  const values = Object.fromEntries(Object.entries((isObj(m) && isObj(m.values) && m.values) || {}).map(([n, v]) => [n, { type: v?.type, bind: v?.bind || 'in', ...(v?.default !== undefined ? { default: v.default } : {}) }]));
  const doc = {
    ok: problems.length === 0,
    name,
    file,
    schema: isObj(m) ? m.schema : undefined,
    values,
    layers: graphs.map((g) => ({
      name: g.name, states: g.names, entry: g.entryTargets, reachable: g.reachable, unreachable: g.unreachable,
      dead_ends: g.deadEnds, zero_time_cycles: g.zeroTimeCycles,
    })),
    clips_checked: Boolean(clipNames),
    problems,
    warnings,
  };
  if (!doc.ok) {
    doc.error = `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${name}.machine.json`;
    doc.hint = problems[0].hint;
  }
  return doc;
};
