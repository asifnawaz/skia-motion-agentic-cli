// Helpers shared by the rig rule files (rules.js, contact-rules.js).

export const r3 = (x) => Math.round(x * 1000) / 1000;
export const secs = (ms) => r3(ms / 1000);

/** [start, end] index pairs (inclusive) of consecutive true entries. */
export const runs = (flags) => {
  const out = [];
  let a = -1;
  flags.forEach((f, i) => {
    if (f && a < 0) a = i;
    if (!f && a >= 0) {
      out.push([a, i - 1]);
      a = -1;
    }
  });
  if (a >= 0) out.push([a, flags.length - 1]);
  return out;
};

/** Largest value and its first index. */
export const argMax = (a, from = 0, to = a.length - 1) => {
  let k = from;
  for (let i = from; i <= to; i++) if (a[i] > a[k]) k = i;
  return k;
};

/** A finding from a rule, with its id, default severity, category and docs topic. */
export const mk = (rule, f) => ({ ruleId: rule.id, severity: rule.default, category: rule.category, docs: rule.docs, ...f });

/** A part's box centre at sample i; a part without w or h is a point. */
export const centreAt = (p, i) => [p.x[i] + (p.w ? p.w[i] : 0) / 2, p.y[i] + (p.h ? p.h[i] : 0) / 2];
