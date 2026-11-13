// Rest-pose check: the drawing at t=0 matches the spec's part boxes before any motion is judged.
//
// For each box in `spec.parts` it reads, from one still at frame 0, the box centre and the midpoint
// of each edge `tol` pt inside and `tol` pt outside. An edge passes when inside and outside differ
// and outside differs from the centre (colours are "equal" within 24 per channel, alpha included).
//
// Known limits:
// - A neighbour at an edge midpoint with the part's colour (outside equals inside) or the centre's
//   colour (outside equals centre) fails that edge even when the box is right. Give the neighbour
//   its own colour, or move the box.
// - A colour boundary inside the part passes: with a 4 pt stroke, a box inset onto the stroke-to-fill
//   line reads fill inside and stroke outside, so an edge up to the stroke's width too far in passes.
//
// deps.pixels.stillPixels(cfg, name, { frame }) -> { width, height, at(xPt, yPt) -> AARRGGBB | null }

const RULE = 'skac/rest-spec';
const NEAR = 24;
const DEFAULT_TOL = 2;

const channels = (argb) => [0, 2, 4, 6].map((i) => parseInt(argb.slice(i, i + 2), 16));

/** Two AARRGGBB colours are the same when every channel is within NEAR. */
const sameColor = (a, b) => {
  const ca = channels(a);
  const cb = channels(b);
  return ca.every((v, i) => Math.abs(v - cb[i]) <= NEAR);
};

/** `tol` in pt, kept below half the box's short side so the inside point stays inside. */
const clampTol = (tol, box) => {
  const half = Math.min(box.w, box.h) / 2;
  const t = Number.isFinite(tol) && tol > 0 ? tol : DEFAULT_TOL;
  return t < half ? t : half / 2;
};

/** `parts` as `{name: box}` or `[{name, x, y, w, h}]`, returned as `[{name, x, y, w, h, tol?}]`. */
const boxes = (parts) =>
  Array.isArray(parts) ? parts : Object.entries(parts || {}).map(([name, b]) => ({ name, ...b }));

/** The four edge probes of a box: midpoint, `t` pt inside and outside. */
const edgeProbes = ({ x, y, w, h }, t) => {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    { edge: 'left', inside: [x + t, cy], outside: [x - t, cy] },
    { edge: 'right', inside: [x + w - t, cy], outside: [x + w + t, cy] },
    { edge: 'top', inside: [cx, y + t], outside: [cx, y - t] },
    { edge: 'bottom', inside: [cx, y + h - t], outside: [cx, y + h + t] },
  ];
};

/** Which edges of `box` fail on `still`; an edge whose probe is off the frame is not judged. */
const failedEdges = (still, box, tol) => {
  const centre = still.at(box.x + box.w / 2, box.y + box.h / 2);
  if (centre === null) return ['centre off the frame'];
  const t = clampTol(box.tol ?? tol, box);
  const failed = [];
  for (const p of edgeProbes(box, t)) {
    const inside = still.at(...p.inside);
    const outside = still.at(...p.outside);
    if (inside === null || outside === null) continue;
    if (sameColor(inside, outside) || sameColor(outside, centre)) failed.push(p.edge);
  }
  return failed;
};

/**
 * Check `spec.parts` boxes against the drawing at t=0.
 * @returns {{findings: object[], skipped: object[]}}
 */
export const restSpec = (cfg, name, spec, deps) => {
  const parts = boxes(spec?.parts);
  if (!parts.length) return { findings: [], skipped: [] };
  let still;
  try {
    still = deps.pixels.stillPixels(cfg, name, { frame: 0 });
  } catch (e) {
    return { findings: [], skipped: [{ ruleId: RULE, layer: 'pixels', reason: `the still at t=0 failed: ${e.message}` }] };
  }
  const findings = [];
  for (const box of parts) {
    const failed = failedEdges(still, box, spec.tol ?? DEFAULT_TOL);
    if (!failed.length) continue;
    findings.push({
      ruleId: RULE,
      severity: 'error',
      docs: 'motion/checks',
      at_s: 0,
      part: box.name,
      edges: failed,
      message: `${box.name}'s box does not match the drawing at t=0 (${failed.join(', ')})`,
      fix: `move ${box.name}'s box in the spec onto its drawn edges, or the drawing onto the box; probe with \`skac ${name} --probe=x,y --at=0\``,
    });
  }
  return { findings, skipped: [] };
};
