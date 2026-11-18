export type AssetAnchor = { x?: 'left' | 'center' | 'right'; y?: 'top' | 'center' | 'bottom' };

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

export function anchorOffset(anchor: AssetAnchor | undefined, insetX: number, insetY: number) {
  'worklet';
  return {
    x: anchor?.x === 'left' ? -insetX : anchor?.x === 'right' ? insetX : 0,
    y: anchor?.y === 'top' ? -insetY : anchor?.y === 'bottom' ? insetY : 0,
  };
}
