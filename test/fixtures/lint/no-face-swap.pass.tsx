export const a = (t: number) => (t < 4000 ? <Path path="M0 0 L4 4" /> : <Path path="M0 0 L4 4" />);
export const b = (ready: boolean) => (ready ? 'M0 0 L10 10 Z' : 'M0 0 L20 5 Z');
export const c = (t: number) => (t < 4000 ? 0 : 1);
