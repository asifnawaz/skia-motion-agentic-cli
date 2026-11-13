// Contact rules (from arXiv 2503.12763's contact metrics): parts stay on the ground and carried parts stay carried.
// Parts are top-left boxes in pt; samples come on rig.js's 120 Hz grid, so times are read from s.t_ms.
import { argMax, centreAt, mk, r3, runs, secs } from './rule-kit.js';

/** pt: how far a box may sink below the ground, or a planted part leave it, before it counts. */
export const GROUND_TOL_PT = 0.5;

const bottomAt = (p, i) => p.y[i] + (p.h ? p.h[i] : 0);
const airborne = (meta, part, t) =>
  (meta.airborne || []).some((w) => t >= w.from_ms && t <= w.to_ms && (!w.parts || w.parts.includes(part)));
const unknownPart = (rule, s, name, key) => mk(rule, {
  message: `meta.${key} names \`${name}\`, which the rig does not return as a part`,
  fix: 'name a part the rig returns, or drop the entry', at_s: 0, part: name,
});

/** One finding per contiguous stretch where `over` is positive, at its worst sample. */
const breaches = (rule, s, name, over, text, fix, limit) =>
  runs(over.map((v) => v > 0)).map(([a, b]) => {
    const k = argMax(over, a, b);
    return mk(rule, { message: text(k), fix, at_s: secs(s.t_ms[k]), part: name, value: r3(over[k] + limit), limit });
  });

const ground = {
  id: 'skac/ground',
  category: 'contact',
  layer: 'rig',
  default: 'error', // calibrated: its mutation in skac-e2e/src/mutations fails it, the base combo passes (13 Nov)
  docs: 'motion/checks',
  needs: ['parts', 'ground_y'],
  // meta: ground_y (pt, the contact line); planted: parts that stand on it; floor: parts drawn on the floor plane
  // (a shadow), exempt from sinking; airborne: [{from_ms, to_ms, parts?}] windows where a planted part may lift
  // (no parts = every planted part, as in a hop).
  check(s, meta) {
    const g = meta.ground_y;
    const floor = new Set(meta.floor || []);
    const planted = meta.planted || [];
    const out = [...planted, ...floor].filter((n) => !s.parts[n]).map((n) => unknownPart(this, s, n, planted.includes(n) ? 'planted' : 'floor'));
    for (const [name, p] of Object.entries(s.parts)) {
      if (floor.has(name)) continue;
      const below = s.t_ms.map((_, i) => bottomAt(p, i) - g);
      out.push(...breaches(this, s, name, below.map((v) => v - GROUND_TOL_PT),
        (k) => `part \`${name}\` sinks ${r3(below[k])} pt below the ground (y ${g}) at ${secs(s.t_ms[k])} s`,
        'keep its bottom on or above meta.ground_y; a squash spreads sideways about the contact line, it never sinks',
        GROUND_TOL_PT));
      if (!planted.includes(name)) continue;
      const lift = s.t_ms.map((t, i) => (airborne(meta, name, t) ? 0 : -below[i]));
      out.push(...breaches(this, s, name, lift.map((v) => v - GROUND_TOL_PT),
        (k) => `planted part \`${name}\` is ${r3(lift[k])} pt off the ground at ${secs(s.t_ms[k])} s, outside meta.airborne`,
        'keep a planted part on the ground, or declare the lift as a meta.airborne window naming the part',
        GROUND_TOL_PT));
    }
    return out;
  },
};

const attached = {
  id: 'skac/attached',
  category: 'contact',
  layer: 'rig',
  default: 'error', // calibrated: its mutation in skac-e2e/src/mutations fails it, the base combo passes (13 Nov)
  docs: 'motion/checks',
  needs: ['parts', 'attached'],
  // meta.attached: [{part, to, within_pt}]: the distance between the two box centres may drift at most within_pt
  // from its value at t=0 (the paper's grasp stability: a carried thing stays carried).
  check(s, meta) {
    const out = [];
    for (const { part, to, within_pt: lim } of meta.attached) {
      const p = s.parts[part];
      const q = s.parts[to];
      if (!p || !q) {
        out.push(unknownPart(this, s, p ? to : part, 'attached'));
        continue;
      }
      const dist = s.t_ms.map((_, i) => {
        const [ax, ay] = centreAt(p, i);
        const [bx, by] = centreAt(q, i);
        return Math.hypot(ax - bx, ay - by);
      });
      const drift = dist.map((d) => Math.abs(d - dist[0]));
      out.push(...breaches(this, s, part, drift.map((v) => v - lim),
        (k) => `part \`${part}\` drifts ${r3(drift[k])} pt from its distance to \`${to}\` at ${secs(s.t_ms[k])} s (within ${lim})`,
        `keep \`${part}\` hinged to \`${to}\`: move it about a pivot on \`${to}\`, or raise within_pt if the request lets it travel`,
        lim));
    }
    return out;
  },
};

export const CONTACT_RULES = [ground, attached];
