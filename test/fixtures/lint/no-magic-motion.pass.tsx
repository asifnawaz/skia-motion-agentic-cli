const BEAT = { a: 4200, b: 4600 };
export const a = (t: number) => flow(t, [[BEAT.a, 0], [BEAT.b, 1]]) + seg(t, 0, 2);
const TOKENS = { rise: track(0, [[0, 1]]), late: hop(0, 900, 1000, 3) };
