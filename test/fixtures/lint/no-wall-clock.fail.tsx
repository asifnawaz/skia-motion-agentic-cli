export const a = () => Date.now();
export const b = () => performance.now();
export const c = () => setTimeout(() => {}, 10);
export const d = () => requestAnimationFrame(() => {});
