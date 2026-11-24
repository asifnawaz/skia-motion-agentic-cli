import { fail } from './util.js';
import { readChain } from './asset-chain.js';

/**
 * Authoring-only fields: a node `id`, a text's `plate` (the id of the plate it sits on), and per artboard `landings`, `allowOverlap`,
 * `register` and `chain`. `skac asset check` reads them; every other command,
 * and the packed `.skmotion`, never sees them, so assets built with them still load in runtimes that predate them.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** After a landing, pieces drawn on its target are its reaction for this long (ms) and are not judged. */
export const REACT_MS = 400;
/** ...and from this long (ms) before it. */
export const REACT_LEAD_MS = 100;
/** The closest a drawn piece may come to text at rest, in artboard points. */
export const TEXT_CLEARANCE = 4;
/** Both pieces hold still this long (ms) for the pair to count as at rest. */
export const REST_MS = 150;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function bad(where, message, hint) {
  fail(`${where}: ${message}`, hint);
}

function collectIds(nodes, parent, ids, at, plates) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node, index) => {
    if (!record(node)) return node;
    const where = `${parent}[${index}]`;
    const { id, plate, ...rest } = node;
    if (plate !== undefined) plates.set(where, { id: plate, at: `${at}${where}.plate` });
    if (id !== undefined) {
      if (typeof id !== 'string' || !IDENTIFIER.test(id)) bad(`${at}${where}.id`, 'expected an identifier', 'use letters, digits, _ or -, starting with a letter');
      if (ids.has(id)) bad(`${at}${where}.id`, `duplicate node id "${id}"`, 'give each node its own id within an artboard');
      ids.set(id, where);
    }
    if (Array.isArray(rest.children)) rest.children = collectIds(rest.children, `${where}.children`, ids, at, plates);
    if (record(rest.pins)) {
      rest.pins = Object.fromEntries(Object.entries(rest.pins).map(([name, pin]) => [name,
        record(pin) && Array.isArray(pin.children) ? { ...pin, children: collectIds(pin.children, `${where}.pins.${name}.children`, ids, at, plates) } : pin]));
    }
    return rest;
  });
}

function readBoard(board, at) {
  if (!record(board)) return { board, meta: undefined };
  const { landings, allowOverlap, register, chain, ...rest } = board;
  const ids = new Map();
  const plates = new Map();
  if (record(rest.artboard)) rest.artboard = { ...rest.artboard, nodes: collectIds(rest.artboard.nodes, 'artboard.nodes', ids, at, plates) };
  const node = (value, where) => {
    if (typeof value !== 'string' || !ids.has(value)) bad(where, `unknown node id ${JSON.stringify(value)}`, 'add "id" to the node and name it here');
    return value;
  };
  const meta = { ids, landings: [], allowOverlap: [], plates: new Map(), chain: readChain(register, chain, at) };
  for (const [where, { id, at: field }] of plates) meta.plates.set(where, node(id, field));
  if (landings !== undefined) {
    if (!Array.isArray(landings) || landings.length > 256) bad(`${at}landings`, 'expected a list of up to 256 landings', 'write [{ "node": "coin", "target": "counterValue" }]');
    landings.forEach((item, i) => {
      const where = `${at}landings[${i}]`;
      if (!record(item) || Object.keys(item).some((key) => !['node', 'target', 'at', 'tolerance', 'aim', 'clip'].includes(key))) {
        bad(where, 'expected { node, target, at?, tolerance?, aim?, clip? }', 'at is a marker name or a time in ms; tolerance is in artboard points; aim: true writes the end keys');
      }
      const landing = { node: node(item.node, `${where}.node`), target: node(item.target, `${where}.target`), tolerance: item.tolerance ?? 0 };
      if (typeof landing.tolerance !== 'number' || !(landing.tolerance >= 0)) bad(`${where}.tolerance`, 'expected a number of points, 0 or more', 'leave it out for 0');
      if (item.at !== undefined) {
        if (!(typeof item.at === 'number' && item.at >= 0) && !(typeof item.at === 'string' && IDENTIFIER.test(item.at))) {
          bad(`${where}.at`, 'expected a marker name or a time in ms', 'leave it out to judge the node where it comes to rest');
        }
        landing.at = item.at;
      }
      if (item.aim !== undefined) {
        if (item.aim !== true) bad(`${where}.aim`, 'expected true', 'aim: true writes the flight\'s end keys onto the target\'s centre; leave it out to key them by hand');
        if (item.at !== undefined) bad(`${where}.at`, 'aim writes the keys where the flight stops, and at judges another moment', 'drop at to aim, or drop aim and key the landing by hand');
        landing.aim = true;
      }
      if (item.clip !== undefined) {
        if (typeof item.clip !== 'string') bad(`${where}.clip`, 'expected a clip name', 'name the clip that keys the flight');
        landing.clip = item.clip;
      }
      meta.landings.push(landing);
    });
  }
  if (allowOverlap !== undefined) {
    if (!Array.isArray(allowOverlap) || allowOverlap.length > 256) bad(`${at}allowOverlap`, 'expected a list', 'write [{ "nodes": ["glow", "title"], "reason": "the glow sits behind the title" }]');
    allowOverlap.forEach((item, i) => {
      const where = `${at}allowOverlap[${i}]`;
      if (!record(item) || !Array.isArray(item.nodes) || item.nodes.length !== 2 || Object.keys(item).some((key) => !['nodes', 'reason'].includes(key))) {
        bad(where, 'expected { nodes: [a, b], reason }', 'name the drawn node and the text node, and why they may meet');
      }
      if (typeof item.reason !== 'string' || !item.reason.trim()) bad(`${where}.reason`, 'expected a reason', 'say why this piece may touch the text');
      meta.allowOverlap.push({ nodes: item.nodes.map((name, k) => node(name, `${where}.nodes[${k}]`)), reason: item.reason });
    });
  }
  return { board: rest, meta };
}

/**
 * Take the authoring-only fields out of a JSON source. Returns the source the runtime parses and, per artboard ('' for a single asset),
 * the node ids (id -> where), landings and overlap allowances.
 */
export function splitAuthoring(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { text, boards: new Map() };
  }
  if (!record(data)) return { text, boards: new Map() };
  const boards = new Map();
  let changed = false;
  const take = (board, name, at) => {
    const { board: clean, meta } = readBoard(board, at);
    if (!meta) return board;
    if (meta.ids.size || meta.landings.length || meta.allowOverlap.length || meta.plates.size || meta.chain) {
      boards.set(name, meta);
      changed = true;
    }
    return clean;
  };
  let clean;
  if (data.schema === 'skac.bundle/1' && record(data.artboards)) {
    clean = { ...data, artboards: Object.fromEntries(Object.entries(data.artboards).map(([name, board]) => [name, take(board, name, `artboards.${name}.`)])) };
  } else {
    clean = take(data, '', '');
  }
  return { text: changed ? JSON.stringify(clean) : text, boards };
}

/** The gap between two boxes in points: negative when they overlap (by the smaller overlap side). */
export function boxGap(a, b) {
  const dx = Math.max(a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(a[1] - b[3], b[1] - a[3]);
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
  return Math.max(dx, dy);
}

/** The gap from a circle to a box: from the box's nearest point to the circle's edge. A centre inside the box is the box gap. */
export function circleGap({ x, y, r }, box) {
  const dx = Math.max(box[0] - x, 0, x - box[2]);
  const dy = Math.max(box[1] - y, 0, y - box[3]);
  if (dx === 0 && dy === 0) return boxGap([x - r, y - r, x + r, y + r], box);
  return Math.hypot(dx, dy) - r;
}

const contains = (outer, inner) => outer[0] <= inner[0] + 0.5 && outer[1] <= inner[1] + 0.5 && outer[2] >= inner[2] - 0.5 && outer[3] >= inner[3] - 0.5;
const round = (value) => Math.round(value * 10) / 10;

/** A node's id, or the id of the nearest group around it with the place inside it; else its place. `names` maps a place to an id. */
export function nodeName(where, names) {
  if (names.has(where)) return names.get(where);
  let owner;
  for (const at of names.keys()) if (where.startsWith(`${at}.`) && (!owner || at.length > owner.length)) owner = at;
  return owner ? `${names.get(owner)} (${where})` : where;
}

/**
 * skac/text-clear: no drawn piece comes within 4 points of a text's box while both hold still for 150 ms or more, or on the last frame.
 * Holding still means neither centre moved in that time, so a glow or ring that pulses in place is at rest. In flight a piece within 4
 * points is a warning.
 * A shape whose box holds the whole text box is the text's background and is not judged, and neither is anything drawn on a landing's
 * target in the 400 ms after the landing (`reacts`: the target's place and the landing time). `rows` holds `{t_ms, entries}`.
 */
export function textClearance(rows, { ids = new Map(), names, allow = [], reacts = [], severity = 'error' }) {
  // A landing's target reacts: anything drawn on it from the landing to REACT_MS after is the point of the chain, not a collision.
  // The window opens REACT_LEAD_MS early: a reaction keyed a frame before contact, or a landing time read one sample late, still counts.
  const reacting = (textAt, t) => reacts.some(({ where, from }) => (textAt === where || textAt.startsWith(`${where}.`))
    && t >= from - REACT_LEAD_MS && t <= from + REACT_MS);
  // An allowance names two nodes by id; a group's id covers everything inside it.
  const covers = (id, where) => {
    const at = ids.get(id);
    return at !== undefined && (where === at || where.startsWith(`${at}.`));
  };
  const ok = (piece, text) => allow.some(({ nodes: [a, b] }) => (covers(a, piece) && covers(b, text)) || (covers(b, piece) && covers(a, text)));
  const texts = new Set();
  const pieces = new Set();
  for (const { entries } of rows) {
    for (const entry of entries.values()) {
      if (entry.text) texts.add(entry.where);
      else if (entry.kind !== 'group' && entry.box) pieces.add(entry.where);
    }
  }
  const errors = [];
  const warnings = [];
  const last = rows.length - 1;
  for (const textAt of texts) {
    for (const pieceAt of pieces) {
      if (ok(pieceAt, textAt)) continue;
      const pair = rows.map(({ t_ms, entries }) => {
        const text = entries.get(textAt);
        const piece = entries.get(pieceAt);
        const row = { t_ms, pieceAt: piece?.centre, textAt: text?.centre };
        if (!text?.box || !piece?.box || contains(piece.box, text.box) || reacting(textAt, t_ms)) return row;
        return { ...row, gap: piece.circle ? circleGap(piece.circle, text.box) : boxGap(piece.box, text.box), text: text.text };
      });
      // At rest: neither the piece nor the text has moved in the REST_MS before (or it is the last frame). Only where they sit counts, so a
      // glow, ring or pop that plays in place on the text is at rest however briefly it shows.
      const still = (i) => {
        if (i === last) return true;
        const { pieceAt: p, textAt: q } = pair[i];
        if (!p || !q || pair[i].t_ms - pair[0].t_ms < REST_MS) return false;
        for (let j = i - 1; j >= 0 && pair[i].t_ms - pair[j].t_ms <= REST_MS; j--) {
          const { pieceAt: pj, textAt: qj } = pair[j];
          if (!pj || !qj || Math.hypot(pj.x - p.x, pj.y - p.y) > 0.5 || Math.hypot(qj.x - q.x, qj.y - q.y) > 0.5) return false;
        }
        return true;
      };
      let rest;
      for (let i = 0; i <= last; i++) {
        const p = pair[i];
        if (p.gap === undefined || p.gap >= TEXT_CLEARANCE || !still(i)) {
          if (rest) break;
          continue;
        }
        if (!rest) rest = { from: p, to: p, closest: p };
        rest.to = p;
        if (p.gap < rest.closest.gap) rest.closest = p;
      }
      const base = {
        rule: 'skac/text-clear', node: nodeName(pieceAt, names), text: nodeName(textAt, names),
      };
      if (rest) {
        const { from, to, closest } = rest;
        errors.push({
          ...base, at_ms: from.t_ms, until_ms: to.t_ms, gap: round(closest.gap), textValue: closest.text.value, textBox: closest.text.source,
          error: `${base.node} rests ${closest.gap < 0 ? `${round(-closest.gap)} pt over` : `${round(closest.gap)} pt from`} the text "${closest.text.value}" (${base.text}) at ${closest.t_ms} ms (at rest ${from.t_ms} to ${to.t_ms} ms); the least is ${TEXT_CLEARANCE} pt`,
          hint: 'move the piece or its landing clear of the text, or name the pair in allowOverlap with a reason',
        });
        continue;
      }
      // In flight: the closest pass is a warning.
      const closest = pair.reduce((best, p) => (p.gap !== undefined && p.gap < TEXT_CLEARANCE && (!best || p.gap < best.gap) ? p : best), undefined);
      if (closest) {
        warnings.push({
          ...base, code: 'text-clear-in-flight', at_ms: closest.t_ms, gap: round(closest.gap), textValue: closest.text.value, textBox: closest.text.source,
          error: `${base.node} passes ${closest.gap < 0 ? `${round(-closest.gap)} pt over` : `${round(closest.gap)} pt from`} the text "${closest.text.value}" (${base.text}) at ${closest.t_ms} ms in flight`,
          hint: 'fine for a pass that moves on; make sure it does not come to rest there',
        });
      }
    }
  }
  if (severity === 'warn') return { errors: [], warnings: [...errors.map((e) => ({ ...e, code: 'text-clear' })), ...warnings] };
  return { errors, warnings };
}

const centre = (box) => ({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });

/** The channels that move a node: the x and y of the node, of every group above and inside it, and path coordinates. */
export function travelChannels(nodes, where) {
  const names = new Set();
  const add = (value) => typeof value === 'string' && names.add(value);
  let list = nodes;
  let node;
  for (const [, key, index] of where.matchAll(/(children|nodes|pins\.[^.[]+\.children)\[(\d+)\]/g)) {
    if (key.startsWith('pins.') && node?.kind === 'mesh') list = node.pins[key.slice(5, -9)].children;
    else if (node) list = node.children;
    node = list[Number(index)];
    add(node.x);
    add(node.y);
  }
  const inside = (item) => {
    if (item !== node) {
      add(item.x);
      add(item.y);
    }
    if (item.kind === 'path') for (const command of item.commands) command.slice(1).forEach(add);
    for (const child of item.children ?? []) inside(child);
  };
  if (node) inside(node);
  return [...names];
}

/**
 * Each landing: at its time (`at`: a marker or ms; else where the node comes to rest, the last time its centre moves), the node's centre must
 * lie inside the target's box widened by `tolerance` points. Returns the measured landings and the first failure.
 */
export function measureLandings(rows, landings, ids, names, asset) {
  const nodes = asset.artboard.nodes;
  return landings.map((landing) => {
    const nodeAt = ids.get(landing.node);
    const targetAt = ids.get(landing.target);
    let index;
    if (typeof landing.at === 'string') {
      index = rows.findIndex(({ markers }) => markers.some(({ name }) => name === landing.at));
      if (index < 0) return { ...landing, problem: `the marker "${landing.at}" never fires in the trace`, hint: 'pass --commands that reach it, or a time in ms' };
    } else if (typeof landing.at === 'number') {
      index = rows.findIndex(({ t_ms }) => t_ms >= landing.at);
      if (index < 0) return { ...landing, problem: `the trace ends before ${landing.at} ms`, hint: 'pass a longer --trace' };
    } else {
      // The end key: the last time a channel that moves the node (an x or y on it or a group above it) changes. Scale and opacity are left
      // out, so a piece that shrinks into its target is judged where it arrived, not where the shrink pulls its centre.
      // Only travel inside one clip counts: a cut to another clip (the snap back to idle) is not a flight, and a looping state that moves
      // the node never ends, so it needs an `at`.
      const travel = travelChannels(nodes, nodeAt);
      const moves = (layer, name) => {
        const state = layer.states?.[name];
        return { state, moves: travel.some((channel) => channel in (asset.clips[state?.clip]?.tracks ?? {})) };
      };
      const layers = asset.machine.layers ?? [];
      // A cut is a layer switching to another clip where either clip moves the node. A state change that keeps the clip, or happens in a
      // layer that never moves the node, does not cut the flight.
      const looping = (states) => layers.some((layer) => {
        const { state, moves: moving } = moves(layer, states[layer.name]);
        return moving && (state?.loop ?? 'once') !== 'once';
      });
      const sameClips = (a, b) => layers.every((layer) => {
        const from = moves(layer, a[layer.name]);
        const to = moves(layer, b[layer.name]);
        return from.state?.clip === to.state?.clip || (!from.moves && !to.moves);
      });
      index = -1;
      for (let i = 1; i < rows.length; i++) {
        if (travel.length) {
          const moved = travel.some((name) => Math.abs(rows[i].channels[name] - rows[i - 1].channels[name]) > 1e-6);
          if (moved && sameClips(rows[i - 1].states, rows[i].states) && !looping(rows[i].states)) index = i;
          continue;
        }
        const a = rows[i - 1].entries.get(nodeAt)?.box;
        const b = rows[i].entries.get(nodeAt)?.box;
        if (a && b && Math.hypot(centre(b).x - centre(a).x, centre(b).y - centre(a).y) > 0.01) index = i;
      }
      if (index < 0) {
        return { ...landing, problem: `${landing.node} never moves in the trace`, hint: 'fire its trigger with --commands (like reveal@0), or give the landing an "at"' };
      }
    }
    const row = rows[index];
    const node = row.entries.get(nodeAt)?.box;
    const target = row.entries.get(targetAt)?.box;
    if (!node) return { ...landing, t_ms: row.t_ms, problem: `${landing.node} draws nothing at ${row.t_ms} ms`, hint: 'check its opacity and scale at the landing time' };
    if (!target) return { ...landing, t_ms: row.t_ms, problem: `${landing.target} draws nothing at ${row.t_ms} ms`, hint: 'the target must be on screen when the node lands' };
    const { x, y } = centre(node);
    const dx = Math.max(target[0] - x, 0, x - target[2]);
    const dy = Math.max(target[1] - y, 0, y - target[3]);
    const distance = round(Math.hypot(dx, dy));
    const result = { ...landing, t_ms: row.t_ms, centre: { x: round(x), y: round(y) }, targetBox: target.map(round), distance };
    if (distance > landing.tolerance) {
      result.rule = 'skac/landing';
      result.problem = `${nodeName(nodeAt, names)} lands ${distance} pt outside ${nodeName(targetAt, names)} at ${row.t_ms} ms (tolerance ${landing.tolerance} pt)`;
      result.hint = 'end the flight on the target, or fix the target the landing names';
    }
    return result;
  });
}
