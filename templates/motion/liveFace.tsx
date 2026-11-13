// liveFace.tsx: a living face for Skia characters with solid eyes (solid oval eyes), adapted from
// rossark-motion-skill templates/react-native/liveFace.tsx (MIT) with huashu-art-motion's face set
// (scripts/engine/lib/toon.js, MIT) turned into channels. See NOTICE.md at the package root and `skac docs motion/faces`.
//
// Nothing ever swaps drawings (rossark §1.1). Every expression is a 0..1 channel that MORPHS one
// shape: the eye's lid lowers, the cheek rises, the eye widens, the one mouth path changes shape.
//
// HOW IT RUNS IN BOTH PLACES
// - Remotion: compute `const f = faceAt(t, CHOREO)` during render and pass it to <LiveEye> and
//   <LiveMouth> (plain numbers; each frame renders on its own).
// - App: compute the same geometry on the UI thread and hand Skia derived values, so React never
//   re-renders per frame:
//     const lid = useDerivedValue(() => eyeGeometry(EYE_L, faceAt(clock.value, CHOREO), -1).lidPath);
//     <Path path={lid} color={SKIN} />
//   Every function below except the two components is a worklet.
import React from 'react';
import { Circle, Group, Oval, Path, rect, rrect } from '@shopify/react-native-skia';
import { eyeGeometry, mouthGeometry, type FaceInk, type FaceState, type SolidEye } from './face';

// The math lives in face.ts (importable without Skia); re-exported so existing imports keep working.
export * from './face';

/** A living solid eye (Remotion: plain values; app: derive eyeGeometry's fields instead). */
export function LiveEye({ eye, face, side, ink }: { eye: SolidEye; face: FaceState; side: -1 | 1; ink: FaceInk }) {
  const g = eyeGeometry(eye, face, side);
  const c = g.clip;
  return (
    <Group>
      <Oval rect={rect(g.eye.x, g.eye.y, g.eye.w, g.eye.h)} color={ink.eye} />
      <Circle cx={g.shine.cx} cy={g.shine.cy} r={g.shine.r} color={ink.shine} opacity={g.shine.opacity} />
      <Group clip={rrect(rect(c.x, c.y, c.w, c.h), c.w / 2, c.h / 2)}>
        <Path path={g.lidPath} color={ink.skin} />
        <Path path={g.cheekPath} color={ink.skin} />
      </Group>
      <Path path={g.closedPath} color={ink.eye} style="stroke" strokeWidth={ink.line} strokeCap="round" opacity={g.closedOpacity} />
      <Path path={g.squeezePath} color={ink.eye} style="stroke" strokeWidth={ink.line} strokeCap="round" strokeJoin="round" opacity={g.squeezeOpacity} />
      <Path path={g.happyPath} color={ink.eye} style="stroke" strokeWidth={ink.line} strokeCap="round" opacity={g.happyOpacity} />
    </Group>
  );
}

/** The living mouth: one filled and stroked path, plus a tongue clipped inside it. */
export function LiveMouth({ cx, y, face, ink }: { cx: number; y: number; face: FaceState; ink: FaceInk }) {
  const m = mouthGeometry(cx, y, face);
  return (
    <Group>
      <Path path={m.path} color={ink.mouth} />
      <Group clip={m.path}>
        <Oval rect={rect(m.tongue.x, m.tongue.y, m.tongue.w, Math.max(0.01, m.tongue.h))} color={ink.tongue} opacity={m.tongue.opacity} />
      </Group>
      <Path path={m.path} color={ink.mouth} style="stroke" strokeWidth={ink.line} strokeJoin="round" strokeCap="round" />
    </Group>
  );
}
