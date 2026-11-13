# Anticipation: the wind-up before a burst

Every burst (a hop, a startled jump, a big wave) starts with a small move the other way. In a side-by-side test of six builds, the LottieFiles-based build had the best wind-up: the character scrunched with its eyes shut before the burst. It also had the sharpest frame of all six videos (peak YDIF 9.63 against rossark's 5.25), because its burst left on an expo-out curve: 72 pt in 300 ms, starting at about 1.5 pt/ms. Keep the wind-up; launch on rossark's gravity arc. (LottieFiles motion-design, anticipation)

## The idea (LottieFiles motion-design, Disney principle 2, in our words)

A short move opposite the main action, at 10–20% of its size, tells the eye something is about to happen, so the burst reads instead of startling. Skip it only on tiny feedback moves shorter than about 150 ms.

## The wind-up, with numbers

| Part | Value | Why |
|---|---|---|
| body squash | down to 0.86–0.88 of its height (12–14%), width by `keepVolume` | rossark crouch 5–10% plus Lottie's 12–16%, met in the middle |
| eyes | `lid` 1 with `squeeze` 1: shut tight, chevrons | Lottie's eyes-shut scrunch (open 0.15 in 50 ms), made a morph |
| mouth | smile flattened to rest; no O | the face gathers in |
| wings or arms | tucked in toward the body, 15–25° | gathering energy |
| into it | 160–220 ms, ease-in-out | Lottie used 100 ms: three frames at 30 fps, a flicker (rossark §1.12) |
| hold at the bottom | 60–100 ms, with idle × 0.3 | the beat before the release |
| eyes open | during the first 100–120 ms of the launch, ease-out | the face leads the body out |

## The launch, capped

- **Launch on the gravity arc**, not on an ease-out: `hop(t, a, b, top)` from motion.ts. Its speed is highest at take-off: `4 × top / (b − a)`.
- **Cap:** no burst is faster than rossark's fastest move, 0.54 pt/ms (4 × 78 pt / 580 ms; about 18 pt a frame at 30 fps). So `air time ≥ 4 × top / 0.54` ms: a 70 pt hop needs at least 520 ms in the air; 78 pt needs 580 ms.
- **Release the squash into the stretch over 80–120 ms**, from 0.86 to at most 1.08. That is under the landing's 0.25 in 140 ms.
- **Stagger the peaks.** The squash release, the wing flap starting and the take-off speed peak must not share one frame; start the flap 2–4 frames after take-off.
- **Measured cap:** the render's peak YDIF (checks) stays at or under 5.25 at 390 wide, rossark's own peak.

## A worked wind-up (a tap at 4000 ms)

The character's body is the round body of the starter in `templates/init/src/Character.tsx`: the squash channel scales the whole body group about the ground point, and the eyes take `lid` and `squeeze` from `liveFace.tsx`. A character with arms or wings adds a `wingTuck` channel.

```ts
const BEAT = { tap: 4000, shock: [4000, 4380], windUp: [4380, 4600], hold: [4600, 4680], air: [4680, 5240], airTop: 66 };
// 4 x 66 / 560 = 0.47 pt/ms: under the 0.54 cap.
const ACT = {
  squash: [[0, 1], [4000, 1], [4090, 0.92], [4250, 0.97], [4380, 0.97], [4600, 0.87], [4680, 0.87], [4760, 1.06], [5240, 1], /* landing */],
  squeeze: [[0, 0], [4380, 0], [4540, 1], [4680, 1], [4790, 0], [8000, 0]],
  wingTuck: [[0, 0], [4380, 0], [4600, 1], [4700, 1], [4780, 0], [8000, 0]],
};
const lidKeys: Key[] = [[0, 0], [4380, 0], [4520, 1], [4680, 1], [4800, 0, 'out'], [8000, 0]];
```
