# Idle: alive, not a breathing icon

In a side-by-side test of six builds, rossark's idle was judged too quiet: breathing, slow sway and glances read as an icon that breathes. Idle needs small events, not only waves.

## Two layers

1. **The always-on layer** (rossark §5.2), on every channel, never off while on screen:
   - breathing: height ±1.5–2% over 2.4–2.8 s (1.2% was too faint on a 150 pt body);
   - weight drift: ±1.5 pt sideways over 4.5–5 s;
   - lean: ±1.5° over 4.5 s;
   - face tilt: ±2° over 4.4 s, plus counter-motion from the lean;
   - wings or arms: 4° on 3 s plus 2° on 1.8 s, left and right out of phase (phase 0 and 0.45);
   - a leaf, ear or tail: 5° on 3.6 s plus 2° on 1.9 s, plus trailing every parent (body, rule 4).
   Periods differ and do not divide each other evenly, so the sum never repeats visibly in a short scene. In a loop, every period must divide the loop length instead (rossark §5.2).
2. **Idle events**, one every 1.2–2 s, each with a cause, a face change and a body change. Mix at least four kinds over 8 s, never the same kind twice in a row:

| Event | What happens | Size and time |
|---|---|---|
| glance | eyes lead to a side, the face tilts, weight shifts toward it; blink on the turn | eyes 6–8 pt, shift 6–7 pt, lean 3–4°, glide 450–500 ms, hold ≥ 1 s |
| look up at its own sprout | eyes up 3–4 pt, lean back 2°, then a small shake that makes the leaf swing | shake ±3° for 2 cycles, 600 ms |
| hum | content squint (`cheek` 0.4), wings flutter | flutter 7° at 330 ms period, inside a 600 ms envelope |
| toe bounce | two small bounces on the spot, feet planted, body only | 3–4 pt lift, 260 ms each, squash 0.97 at each bottom |
| wing shuffle | one wing settles, then the other 120 ms later | 8–10° each, 300 ms |
| double blink | two blinks 260 ms apart | as faces |

Rules:
- **A cause for each event:** something in the scene, its own sprout, the viewer. The eyes go first (faces).
- **Back to the viewer** before any input it should react to: the last idle event ends facing front 300–500 ms before the tap, so the reaction starts from a clean, readable pose.
- **Small:** events stay inside the body's moving-hold sizes plus the table above. No hops in idle (a hop is a burst, kept for the reaction).
- **Never two events at once,** and never every part still at once.
- **Frozen during shock only:** in a shock hold the always-on layer drops to 30% for 250–400 ms, never to 0 (body, rule 2; huashu's frozen shock).
