// Skia's web canvas asks for a display-p3 drawing buffer, which shifts colours. Pin it to sRGB.
if (typeof window !== 'undefined') {
  for (const ctor of [window.WebGLRenderingContext, (window as any).WebGL2RenderingContext]) {
    if (ctor) Object.defineProperty(ctor.prototype, 'drawingBufferColorSpace', { configurable: true, get: () => 'srgb', set: () => undefined });
  }
}

import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Picture, Skia, createPicture } from '@shopify/react-native-skia';
import { SkiaCanvas } from '@remotion/skia';
import { draw } from './Interface.draw';
import { meta, rig, type RigEvent } from './Interface.rig';

// Draws with draw() in Interface.draw.ts from rig(ms) in Interface.rig.ts, the same two the app gets from
// `skac Interface --export <dir>`. Pass events with: skac Interface --commands "tap@4.0"
export const Interface = ({ events = meta.events }: { events?: RigEvent[] }) => {
  const { fps, width, height } = useVideoConfig();
  const ms = (useCurrentFrame() / fps) * 1000;
  const picture = createPicture((canvas) => draw(canvas, rig(ms, events).channels, { width, height }), Skia.XYWHRect(0, 0, width, height));

  return (
    <AbsoluteFill>
      <SkiaCanvas width={width} height={height}>
        <Picture picture={picture} />
      </SkiaCanvas>
    </AbsoluteFill>
  );
};
