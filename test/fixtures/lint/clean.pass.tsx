import { EASE_OUT, flow, seeded, spring } from '../../../templates/motion/motion';

const BEAT = { wind: 4.2, hop: 4.6 };

export const wing = (t: number) => flow(t, [[BEAT.wind, 0], [BEAT.hop, 1]]) * seeded(3) * spring(t, 500, 0.05) * EASE_OUT(0.5);
export const face = (t: number) => (t > BEAT.hop ? 1 : 0);
