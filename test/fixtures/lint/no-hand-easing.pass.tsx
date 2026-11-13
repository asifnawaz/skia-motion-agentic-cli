import { EASE_OUT, bezier } from './motion/motion';

const knots = [0.2, 0, 0.1, 1];
export const a = EASE_OUT(0.5);
export const curve = bezier(knots[0], 0, knots[2], 1);
