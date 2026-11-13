// Skia's web canvas asks the GPU for a display-p3 drawing buffer, which shifts every colour.
// Pin it to sRGB before anything draws, so the render shows the hex values you wrote.
if (typeof window !== 'undefined') {
  for (const ctor of [window.WebGLRenderingContext, (window as any).WebGL2RenderingContext]) {
    if (ctor) Object.defineProperty(ctor.prototype, 'drawingBufferColorSpace', { configurable: true, get: () => 'srgb', set: () => undefined });
  }
}

import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { BlurMask, Circle, Group, Oval, Path, rect, vec } from '@shopify/react-native-skia';
import { SkiaCanvas } from '@remotion/skia';
import { DEG } from './motion/motion';
import { BODY, SPROUT, meta, rig, type RigEvent } from './Character.rig';

// A small character with an idle and a reaction to `tap` events.
// It draws only from rig(ms) in Character.rig.ts, where every moving value lives, so a frame renders the same way twice
// and `skac Character --check` tests the numbers drawn here. The shapes are an example, not a look to copy.

const COLOR = { bg: '#1E2A44', body: '#F6C453', edge: '#D9962B', ink: '#2B2118', cheek: '#F08A7E', leaf: '#5FB57A', stem: '#3E8A57', shadow: '#0B1222' };

/** One leaf from the stem to its tip, bowed by leafBulge on both sides; side -1 = left, 1 = right. */
const leafPath = (cx: number, top: number, side: number) => {
  const { leafBase, leafTip, leafBulge } = SPROUT;
  const bx = cx, by = top + leafBase;
  const tx = cx + side * leafTip.x, ty = top + leafTip.y;
  const mx = (bx + tx) / 2, my = (by + ty) / 2;
  const len = Math.hypot(tx - bx, ty - by);
  const nx = (-(ty - by) / len) * leafBulge * 2, ny = ((tx - bx) / len) * leafBulge * 2;
  return `M${bx} ${by}Q${mx + nx} ${my + ny} ${tx} ${ty}Q${mx - nx} ${my - ny} ${bx} ${by}Z`;
};

export const Character = ({ events = meta.events }: { events?: RigEvent[] }) => {
  const { fps } = useVideoConfig();
  const { sx, sy, lift, look, look_up: lookUp, shift, sprout_tilt: sproutTilt, lid, shadow_k: shadowK } = rig((useCurrentFrame() / fps) * 1000, events).channels;
  const { cx, ground, width, height, stroke } = BODY;
  const top = ground - height;
  const eyeH = 22 * (1 - lid);

  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.bg }}>
      <SkiaCanvas width={meta.width} height={meta.height}>
        <Oval rect={rect(cx - 70 * shadowK, ground - 6, 140 * shadowK, 16)} color={COLOR.shadow} opacity={0.4 * shadowK}>
          <BlurMask blur={4} style="normal" />
        </Oval>
        <Group origin={vec(cx, ground)} transform={[{ translateX: shift }, { translateY: -lift }, { scaleX: sx }, { scaleY: sy }]}>
          <Group origin={vec(cx, top)} transform={[{ rotate: sproutTilt * DEG }]}>
            {/* The round cap adds half the stem's width, so the line stops that far short of the tip. */}
            <Path path={`M${cx} ${top + SPROUT.stemBase}L${cx} ${top + SPROUT.stemTip + SPROUT.stemWidth / 2}`} color={COLOR.stem} style="stroke" strokeWidth={SPROUT.stemWidth} strokeCap="round" />
            {[-1, 1].map((s) => <Path key={s} path={leafPath(cx, top, s)} color={COLOR.leaf} />)}
          </Group>
          <Oval rect={rect(cx - width / 2, top, width, height)} color={COLOR.body} />
          <Oval rect={rect(cx - width / 2, top, width, height)} color={COLOR.edge} style="stroke" strokeWidth={stroke} />
          {[-1, 1].map((s) => (
            <Group key={s}>
              <Circle cx={cx + s * 46 + look * 0.5} cy={top + 98} r={11} color={COLOR.cheek} opacity={0.6} />
              <Oval rect={rect(cx + s * 26 + look - 8, top + 70 + lookUp + (22 - eyeH) / 2, 16, eyeH)} color={COLOR.ink} />
            </Group>
          ))}
          <Path path={`M${cx - 14 + look * 0.6} ${top + 104}Q${cx + look * 0.6} ${top + 118} ${cx + 14 + look * 0.6} ${top + 104}`} color={COLOR.ink} style="stroke" strokeWidth={4} strokeCap="round" />
        </Group>
      </SkiaCanvas>
    </AbsoluteFill>
  );
};
