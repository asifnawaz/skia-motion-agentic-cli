export const a = (t: number) => (t < 4000 ? <Path path="M0 0 L4 4" /> : <Circle r={3} />);
export const b = (ms: number) => (ms < 4000 ? 'M0 0 L10 10 Z' : 'M0 0 L20 5 Z');
