import { nodeName, REST_MS } from './asset-clear.js';

/** Centring and equal padding hold within this many points. */
export const CENTRE_TOLERANCE = 1;
/** Content keeps at least this much room inside its plate, in points. */
export const PLATE_INSET = 4;
/** A plate may change size by at most this much between values, in points. */
export const PLATE_RESIZE = 1;

const width = (box) => box[2] - box[0];
const height = (box) => box[3] - box[1];
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const inside = (outer, inner) => inner[0] >= outer[0] - 0.5 && inner[1] >= outer[1] - 0.5 && inner[2] <= outer[2] + 0.5 && inner[3] <= outer[3] + 0.5;
const round = (value) => Math.round(value * 10) / 10;

/** Every node's place in draw order, and the filled round rects that can be plates. */
function walk(nodes) {
  const order = new Map();
  const plates = [];
  const shapes = new Set();
  const aligns = new Map();
  const visit = (list, parent, row = false) => list.forEach((node, index) => {
    const where = `${parent}[${index}]`;
    order.set(where, order.size);
    if (node.kind === 'text') aligns.set(where, node.align);
    // A shape a row places is content beside its text, like an icon, not a plate.
    if (row && (node.kind === 'ellipse' || node.kind === 'roundRect')) shapes.add(where);
    else if (node.kind === 'roundRect' && node.fill !== undefined && !node.feather) plates.push(where);
    // A row's plate draws before its children, as their first sibling.
    if (node.kind === 'group' && node.row?.plate) {
      order.set(`${where}.children[plate]`, order.size);
      plates.push(`${where}.children[plate]`);
    }
    if (node.kind === 'group') visit(node.children, `${where}.children`, Boolean(node.row));
    if (node.kind === 'mesh') for (const [name, pin] of Object.entries(node.pins ?? {})) if (pin.children) visit(pin.children, `${where}.pins.${name}.children`);
  });
  visit(nodes, 'artboard.nodes');
  return { order, plates, shapes, aligns };
}

/**
 * For skac/text-clear: whether a piece is a text's own plate (a filled, unfeathered round rect drawn before it in a group that holds it,
 * a row's plate, or the node its `plate` names), and the shapes rows place, which sit beside their text like icons.
 */
export function platesOf(asset, { ids = new Map(), declared = new Map() } = {}) {
  const { order, plates, shapes } = walk(asset.artboard.nodes);
  const isPlate = (pieceAt, textAt) => (declared.has(textAt) ? ids.get(declared.get(textAt)) === pieceAt : candidates(textAt, plates, order).includes(pieceAt));
  return { isPlate, icons: shapes };
}

/** The plates a text can sit on: a filled round rect drawn before it whose parent holds the text, nearest first. */
function candidates(textAt, plates, order) {
  return plates
    .filter((plateAt) => {
      const parent = plateAt.slice(0, plateAt.lastIndexOf('['));
      return textAt.startsWith(`${parent}[`) && order.get(plateAt) < order.get(textAt);
    })
    .sort((a, b) => b.length - a.length || order.get(b) - order.get(a));
}

/** Whether every listed node held its place over the REST_MS before row i (or i is the last row). */
function still(rows, i, places) {
  if (i === rows.length - 1) return true;
  if (rows[i].t_ms - rows[0].t_ms < REST_MS) return false;
  for (const where of places) {
    const here = rows[i].entries.get(where)?.centre;
    if (!here) return false;
    for (let j = i - 1; j >= 0 && rows[i].t_ms - rows[j].t_ms <= REST_MS; j--) {
      const then = rows[j].entries.get(where)?.centre;
      if (!then || Math.hypot(then.x - here.x, then.y - here.y) > 0.5) return false;
    }
  }
  return true;
}

/**
 * skac/text-in-plate. A text on a plate (a filled round rect drawn behind it in the same group, or the node its `plate` names; a round
 * rect that also holds another round rect beside the text is a card, not a plate) is judged at
 * rest with what shares the plate (other texts and images, and the shapes a row places): the content is centred across and down within 1 pt
 * (across unless a text on it says align "start" or "end", which lays it out on a row background; a text with no align, a row's plate
 * and a declared plate are always judged across) (down by the texts' optical
 * band, not their boxes), keeps 4 pt inside every edge, and the plate changes size by at most 1 pt between the values its texts show.
 * An image beside a text on one row (their heights overlap by more than half) is centred on the text's optical band within 1 pt, and the
 * ink gap between them holds within 1 pt across values. Texts with no laid-out font are listed under `unmeasured` and not judged.
 */
export function textInPlate(rows, { asset, ids = new Map(), names = new Map(), declared = new Map(), severity = 'error' }) {
  const { order, plates, shapes, aligns } = walk(asset.artboard.nodes);
  const errors = [];
  const unmeasured = new Set();
  const texts = new Set();
  const images = new Set();
  for (const { entries } of rows) {
    for (const entry of entries.values()) {
      if (entry.text) texts.add(entry.where);
      if ((entry.kind === 'image' || shapes.has(entry.where)) && entry.box) images.add(entry.where);
    }
  }
  const name = (where) => nodeName(where, names);
  const report = (problem) => errors.push({ rule: 'skac/text-in-plate', ...problem });

  // Each text's plate at each row: the declared one, else the nearest candidate whose box holds the text's ink.
  const plateOf = (textAt, entries) => {
    const text = entries.get(textAt);
    if (!text?.box) return undefined;
    if (declared.has(textAt)) return ids.get(declared.get(textAt));
    const area = (at) => width(entries.get(at).box) * height(entries.get(at).box);
    // A card is not a plate: a round rect that holds another filled round rect beside the text (a heading over a nested pill) is a
    // container, and the text on it is laid out by the card, not centred on it.
    const card = (at) => plates.some((other) => other !== at && order.get(other) > order.get(at) && entries.get(other)?.box
      && inside(entries.get(at).box, entries.get(other).box) && !inside(entries.get(other).box, text.box));
    return candidates(textAt, plates, order).filter((at) => entries.get(at)?.box && inside(entries.get(at).box, text.box) && !card(at))
      .sort((a, b) => area(a) - area(b))[0];
  };

  // ---- plates -------------------------------------------------------------------------------------------------------------------------
  const seen = new Map(); // plate -> { reported: Set, sizes: [{t_ms, size, values}] }
  rows.forEach(({ t_ms, entries }, i) => {
    const byPlate = new Map();
    for (const textAt of texts) {
      if (!entries.get(textAt)?.box) continue;
      const plateAt = plateOf(textAt, entries);
      if (!plateAt) continue;
      if (!byPlate.has(plateAt)) byPlate.set(plateAt, []);
      byPlate.get(plateAt).push(textAt);
    }
    for (const [plateAt, members] of byPlate) {
      const plate = entries.get(plateAt)?.box;
      if (!plate) continue;
      const icons = [...images].filter((at) => order.get(at) > order.get(plateAt) && entries.get(at)?.box && inside(plate, entries.get(at).box));
      if (!still(rows, i, [plateAt, ...members, ...icons])) continue;
      if (members.some((at) => !entries.get(at).text.band)) {
        members.forEach((at) => unmeasured.add(name(at)));
        continue;
      }
      const state = seen.get(plateAt) ?? { reported: new Set(), sizes: [] };
      seen.set(plateAt, state);
      let ink;
      let optical;
      for (const at of members) {
        const { box, text } = entries.get(at);
        ink = union(ink, box);
        optical = union(optical, [box[0], text.band[0], box[2], text.band[1]]);
      }
      for (const at of icons) {
        ink = union(ink, entries.get(at).box);
        optical = union(optical, entries.get(at).box);
      }
      const left = optical[0] - plate[0];
      const right = plate[2] - optical[2];
      const top = optical[1] - plate[1];
      const bottom = plate[3] - optical[3];
      const label = `${members.map((at) => `"${entries.get(at).text.value}"`).join(' ')} on ${name(plateAt)}`;
      const once = (key, problem) => {
        if (state.reported.has(key)) return;
        state.reported.add(key);
        report({ plate: name(plateAt), texts: members.map(name), icons: icons.map(name), at_ms: t_ms, ...problem });
      };
      // A text with align "start" or "end" on a shape is laid out on a row background (a table row's label, a value in its cell), so only
      // its inset and its centre down are judged. A text with no align is unknown and gets the full check, as do a row's plate and a
      // declared plate.
      const laidOut = !plateAt.endsWith('.children[plate]')
        && members.some((at) => !declared.has(at) && (aligns.get(at) === 'start' || aligns.get(at) === 'end'));
      if (!laidOut && Math.abs(left - right) > CENTRE_TOLERANCE) {
        once('across', { offset: round((left - right) / 2), error: `${label} is ${round(Math.abs(left - right) / 2)} pt off centre across at ${t_ms} ms (padding ${round(left)} pt left, ${round(right)} pt right)`, hint: 'centre the content group (icons and texts together) in the plate, or size the plate from the measured content' });
      }
      if (Math.abs(top - bottom) > CENTRE_TOLERANCE) {
        once('down', { offset: round((top - bottom) / 2), error: `${label} is ${round(Math.abs(top - bottom) / 2)} pt off centre down at ${t_ms} ms (optical band ${round(top)} pt from the top, ${round(bottom)} pt from the bottom)`, hint: 'centre the texts\' optical band (cap height over the baseline), not their boxes, in the plate' });
      }
      const room = Math.min(ink[0] - plate[0], ink[1] - plate[1], plate[2] - ink[2], plate[3] - ink[3]);
      if (room < PLATE_INSET) {
        once('inset', { room: round(room), error: `${label} comes ${round(room)} pt from the plate's edge at ${t_ms} ms; the least is ${PLATE_INSET} pt`, hint: 'grow the plate or its padding; never shrink the text' });
      }
      const values = members.map((at) => entries.get(at).text.value).join('|');
      state.sizes.push({ t_ms, values, size: [width(plate), height(plate)] });
    }
  });
  for (const [plateAt, { sizes }] of seen) {
    const first = sizes[0];
    const changed = sizes.find(({ values, size }) => values !== first.values
      && (Math.abs(size[0] - first.size[0]) > PLATE_RESIZE || Math.abs(size[1] - first.size[1]) > PLATE_RESIZE));
    if (changed) {
      report({ plate: name(plateAt), at_ms: changed.t_ms,
        error: `${name(plateAt)} changes size from ${first.size.map(round).join(' x ')} pt ("${first.values}", ${first.t_ms} ms) to ${changed.size.map(round).join(' x ')} pt ("${changed.values}", ${changed.t_ms} ms); the most is ${PLATE_RESIZE} pt`,
        hint: 'size the plate for the widest value (tabular digits) so it holds still while the value changes' });
    }
  }

  // ---- icon beside text -----------------------------------------------------------------------------------------------------------
  const pairs = new Map(); // `${icon}|${text}` -> {gaps: [{t_ms, gap}], reported}
  rows.forEach(({ t_ms, entries }, i) => {
    for (const iconAt of images) {
      const icon = entries.get(iconAt)?.box;
      if (!icon) continue;
      const beside = [];
      for (const textAt of texts) {
        const text = entries.get(textAt);
        if (!text?.box) continue;
        const band = text.text.band ?? [text.box[1], text.box[3]];
        const overlap = Math.min(icon[3], band[1]) - Math.max(icon[1], band[0]);
        if (overlap <= Math.min(height(icon), band[1] - band[0]) / 2) continue;
        const gap = text.box[0] >= icon[2] - 1 ? text.box[0] - icon[2] : icon[0] >= text.box[2] - 1 ? icon[0] - text.box[2] : undefined;
        if (gap === undefined || gap > Math.max(height(icon), band[1] - band[0])) continue;
        beside.push({ textAt, text, band, gap, side: text.box[0] >= icon[2] - 1 ? 'right' : 'left' });
      }
      // The nearest text on each side is the icon's row partner.
      for (const side of ['left', 'right']) {
        const partner = beside.filter((b) => b.side === side).sort((a, b) => a.gap - b.gap)[0];
        if (!partner) continue;
        const { textAt, text, gap } = partner;
        if (!still(rows, i, [iconAt, textAt])) continue;
        const key = `${iconAt}|${textAt}`;
        const state = pairs.get(key) ?? { gaps: [], reported: false };
        pairs.set(key, state);
        state.gaps.push({ t_ms, gap, value: text.text.value });
        if (!text.text.band) {
          unmeasured.add(name(textAt));
          continue;
        }
        const offset = (icon[1] + icon[3]) / 2 - (text.text.band[0] + text.text.band[1]) / 2;
        if (!state.reported && Math.abs(offset) > CENTRE_TOLERANCE) {
          state.reported = true;
          report({ icon: name(iconAt), text: name(textAt), at_ms: t_ms, offset: round(offset),
            error: `${name(iconAt)} sits ${round(Math.abs(offset))} pt ${offset > 0 ? 'below' : 'above'} the optical centre of "${text.text.value}" (${name(textAt)}) at ${t_ms} ms; the most is ${CENTRE_TOLERANCE} pt`,
            hint: 'centre the icon on the middle of the text\'s optical band (cap height for "+3", x-height for lowercase, between for a mixed label), not on the text box' });
        }
      }
    }
  });
  for (const [key, { gaps }] of pairs) {
    const [iconAt, textAt] = key.split('|');
    const low = gaps.reduce((a, b) => (b.gap < a.gap ? b : a));
    const high = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
    if (high.gap - low.gap > CENTRE_TOLERANCE) {
      report({ icon: name(iconAt), text: name(textAt), at_ms: high.t_ms,
        error: `the ink gap from ${name(iconAt)} to ${name(textAt)} changes from ${round(low.gap)} pt ("${low.value}", ${low.t_ms} ms) to ${round(high.gap)} pt ("${high.value}", ${high.t_ms} ms); it must hold within ${CENTRE_TOLERANCE} pt`,
        hint: 'start-align the text against the icon (or lay the row out from the measured ink) so the gap is one value' });
    }
  }
  const out = { errors, unmeasured: [...unmeasured] };
  if (severity === 'warn') return { errors: [], warnings: errors.map((e) => ({ ...e, code: 'text-in-plate' })), unmeasured: out.unmeasured };
  return { ...out, warnings: [] };
}
