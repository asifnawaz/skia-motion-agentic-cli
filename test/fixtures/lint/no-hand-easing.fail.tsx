import { bezier } from './motion/motion';

export const a = bezier(0.2, 0, 0.1, 1);
export const b = Easing.out(Easing.cubic);
export const ease = [0.2, 0, 0.1, 1];
export const css = 'cubic-bezier(0.2, 0, 0.1, 1)';
