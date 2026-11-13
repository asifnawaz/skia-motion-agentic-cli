/** A helper the rig imports, so the bundle must follow imports. */
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const easeOut = (p: number): number => 1 - (1 - clamp01(p)) ** 3;
