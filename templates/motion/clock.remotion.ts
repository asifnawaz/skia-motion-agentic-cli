// clock.remotion.ts: the Remotion clock, plus the sRGB fix every Skia composition needs.
//
// HOW IT RUNS: Remotion only. The app uses clock.app.ts. In Remotion each frame renders on its
// own, so time is a pure function of the frame: t = frame / fps * 1000. Compute every value
// during render from `t` with the functions in motion.ts; never keep state between frames.
//
//   import './clock.remotion';                // FIRST import of the composition: runs the sRGB fix
//   const t = useClockMs();                   // ms since frame 0
import { useCurrentFrame, useVideoConfig } from 'remotion';

// sRGB fix. Skia on the web asks WebGL for a "display-p3" drawing buffer; the video is sRGB,
// so colours shift and #F2E6C9 no longer matches the spec. Force "srgb" before Skia creates its
// first context. This must run before any Skia code, so keep it at the very top of the entry
// file (or import this module first).
if (typeof window !== 'undefined') {
  for (const ctor of [window.WebGLRenderingContext, (window as any).WebGL2RenderingContext]) {
    if (ctor) Object.defineProperty(ctor.prototype, 'drawingBufferColorSpace', { configurable: true, get: () => 'srgb', set: () => undefined });
  }
}

/** Milliseconds since frame 0 of this composition. */
export function useClockMs(): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (frame / fps) * 1000;
}
