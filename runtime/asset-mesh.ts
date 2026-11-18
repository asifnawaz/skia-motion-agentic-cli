import type { AssetNode, Scalar } from './asset';

export type MeshVertex = readonly [x: Scalar, y: Scalar, u: number, v: number];
export type MeshPin = {
  triangle: number;
  weights: readonly [number, number, number];
  children?: readonly AssetNode[];
};
export type MeshNode = {
  kind: 'mesh';
  image: string;
  vertices: readonly MeshVertex[];
  indices: readonly number[];
  opacity?: Scalar;
  pins?: Readonly<Record<string, MeshPin>>;
};

type Channels = Readonly<Record<string, number>>;

export function meshPosition([x, y]: MeshVertex, channels: Channels) {
  'worklet';
  return { x: typeof x === 'string' ? channels[x]! : x, y: typeof y === 'string' ? channels[y]! : y };
}

export function meshPinPosition(mesh: Pick<MeshNode, 'vertices' | 'indices'>, pin: Pick<MeshPin, 'triangle' | 'weights'>, channels: Channels) {
  'worklet';
  let x = 0;
  let y = 0;
  const start = pin.triangle * 3;
  for (let i = 0; i < 3; i++) {
    const vertex = meshPosition(mesh.vertices[mesh.indices[start + i]!]!, channels);
    const weight = pin.weights[i]!;
    x += vertex.x * weight;
    y += vertex.y * weight;
  }
  return { x, y };
}
