export type AssetAnchor = { x?: 'left' | 'center' | 'right'; y?: 'top' | 'center' | 'bottom' };
export type AssetFit = 'contain' | 'cover' | 'scaleDown' | 'none';
export type AssetLayoutOptions = { fit?: AssetFit; alignment?: AssetAnchor };

type Size = { width: number; height: number };

/** Express the viewport's unused space on either side of the fitted artboard in artboard points. */
export function layoutAsset(artboard: Size, width: number, height: number) {
  'worklet';
  const scale = Math.min(width / artboard.width, height / artboard.height);
  return {
    scale,
    insetX: Math.max(0, (width / scale - artboard.width) / 2),
    insetY: Math.max(0, (height / scale - artboard.height) / 2),
  };
}

/** Resolve an oriented viewport in artboard units. Signed offsets also handle cover clipping. */
export function fitAsset(artboard: Size, width: number, height: number, options: AssetLayoutOptions = {}) {
  'worklet';
  const contain = layoutAsset(artboard, width, height);
  const { fit = 'contain', alignment } = options;
  const scale = fit === 'cover' ? Math.max(width / artboard.width, height / artboard.height)
    : fit === 'none' ? 1 : fit === 'scaleDown' ? Math.min(1, contain.scale) : contain.scale;
  const spaceX = fit === 'contain' ? contain.insetX * 2 : width / scale - artboard.width;
  const spaceY = fit === 'contain' ? contain.insetY * 2 : height / scale - artboard.height;
  const fractionX = alignment?.x === 'left' ? 0 : alignment?.x === 'right' ? 1 : 0.5;
  const fractionY = alignment?.y === 'top' ? 0 : alignment?.y === 'bottom' ? 1 : 0.5;
  return { scale, spaceX, spaceY, offsetX: spaceX * fractionX, offsetY: spaceY * fractionY };
}

export function fittedAnchorOffset(anchor: AssetAnchor | undefined, layout: ReturnType<typeof fitAsset> | undefined) {
  'worklet';
  if (!layout) return { x: 0, y: 0 };
  const dx = anchor?.x === 'left' ? 0 : anchor?.x === 'right' ? layout.spaceX : layout.spaceX / 2;
  const dy = anchor?.y === 'top' ? 0 : anchor?.y === 'bottom' ? layout.spaceY : layout.spaceY / 2;
  return {
    x: anchor?.x && layout.spaceX > 0 ? dx - layout.offsetX : 0,
    y: anchor?.y && layout.spaceY > 0 ? dy - layout.offsetY : 0,
  };
}

export function anchorOffset(anchor: AssetAnchor | undefined, insetX: number, insetY: number) {
  'worklet';
  return {
    x: anchor?.x === 'left' ? -insetX : anchor?.x === 'right' ? insetX : 0,
    y: anchor?.y === 'top' ? -insetY : anchor?.y === 'bottom' ? insetY : 0,
  };
}
