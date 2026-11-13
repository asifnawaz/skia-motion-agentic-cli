# Faces and expression

The face set comes from huashu-art-motion (toon.js: shock, happy, blank, worry; rig_huashu.js: blink, mouth open; and a frozen shock, open grin and wave from a side-by-side test of six builds). The mechanics come from rossark: nothing swaps, every change is a channel that morphs one shape (rossark §1.1, §4). `templates/motion/liveFace.tsx` implements all of it.

The face has solid oval eyes, a mouth and cheeks, like the starter character in `templates/init/src/Character.tsx`.

## How huashu's set becomes channels

huashu switches whole drawings: a pose change takes 0.1 s on expo-out, and the eyes swap from dots to arcs in one frame (huashu toon.js poseAt, 0.1 s; in the six-build test, glances that snapped in 0.1 s). On a phone at 30 fps that is three frames and reads as a twitch. Here each expression is a 0–1 channel, moved by `flow` (or `track` for a lid), and every change takes at least 100 ms (rossark §1.12). Typical: 150–250 ms for a face change, 300–500 ms for a glance.

| Expression | Channels at full | Into it | Hold | Out of it | Source |
|---|---|---|---|---|---|
| **open** (rest) | all 0 (the mouth rests as the smile) | — | — | — | spec face |
| **blink** | `lid` 1 | close 110 ms, ease-in-out | 30–50 ms | reopen 190 ms, ease-out | rossark §4 |
| **look** | `lookX` ±6–8 pt, `lookY` −3..+5 pt | 300–500 ms, glide | ≥ 1 s | 300–500 ms | rossark §4 (huashu snapped 0.1 s; not used) |
| **shock** (frozen) | `wide` 1 (eyes 1.25×, shine 0.7×), `o` 1, body idle × 0.3 | 100–120 ms, ease-out | 250–400 ms | 200–300 ms | huashu toon.js `shock` |
| **delight** (^^) | `cheek` 1 (lower lid rises, happy arc fades in above 0.86) | 200–300 ms | 0.6–1.2 s | 250–300 ms | huashu `happy`; rossark `cheek` |
| **grin** (open) | `grin` 1: mouth opens to a D 26 pt wide, 15 pt deep, tongue shows | 200–300 ms, ease-out | with delight | 300 ms | huashu toon.js mouth 2 |
| **squint** (content) | `cheek` 0.35–0.5 | 200 ms | 0.3–0.6 s | 200 ms | huashu `happy` (partial); rossark hum |
| **squeeze** (wind-up) | `lid` 1 + `squeeze` 1: closed line becomes a tight chevron | 120–160 ms | 60–120 ms | 100–120 ms | LottieFiles wind-up; anticipation |
| **worry** | `lookY` +3, `cheek` 0.15, mouth at rest, head tilt 3° toward the worry | 300 ms | as needed | 300 ms | huashu toon.js `worry` |

Rules for the set:
- **One shape per feature.** The eye is one oval under one skin lid; the mouth is one path. A blend of channels morphs it. Two expressions never crossfade as two drawings. (rossark §1.1)
- **Expression leads, body follows.** The face changes first; the body's matching pose arrives 60–120 ms later. (rossark §5.4, applied to the face)
- **Blink on head turns and before a new expression** of any size (shock excepted: shock opens wider, no blink). (rossark §4, §5.6)
- **Lines appear only near the end of a lid's travel.** The closed line fades in over the last 12% of `lid`; the happy arc over the last 14% of `cheek`. (rossark liveFace)
- **Lid clip.** The skin lids are clipped to a shape 1–2 pt larger than the eye; with the exact eye, the anti-aliased edge leaks around a closed eye and reads as glasses. (rossark §4)

## The readable surprised mouth

In a side-by-side test of six builds, rossark's surprised mouth was about 10 × 12 pt, solid ink, the same darkness as the eyes, so at phone size it read as a third dot, not an open mouth. Huashu's 9 × 11 oval had the same size but read better because it arrived with wider eyes. The rule:

- **Minimum size:** at least 14 pt wide and 18 pt tall at a 390 pt wide frame. That is 70% of the eye's height and as wide as the eye: smaller and it reads as a dot or a nostril.
- **Shape:** an upright oval, taller than wide (about 0.75 : 1), with rounded ends. Not a circle (reads as a dot), not wider than tall (reads as a grin).
- **Interior:** the opening is mouth ink with the tongue colour in its lower 40%, so it reads as a hollow, not a solid dot. Its outline is the same 3 pt stroke as the smile.
- **Context:** it comes with `wide` 1 on the eyes. An O without wide eyes reads as a whistle.
- **Judge it at 390 pt wide** (the phone's own size), not on the 2× render: look at the frame scaled to 390 wide.

`mouthGeometry` in liveFace.tsx draws exactly this at `o` = 1: width 14, top −12, bottom +12, full half-width handles.

## The mouth's three key shapes

All three are the same two-cubic path between the mouth corners (liveFace.tsx `mouthGeometry`):

| Shape | width | top handle | bottom handle | handle reach | reads as |
|---|---|---|---|---|---|
| smile (rest) | 22 | +6 | +6 | 0.5 | the spec's 22 pt arc, 4.5 pt deep, 3 pt stroke |
| grin | 26 | +3 | +20 | 0.5 | an open D with the tongue |
| O | 14 | −12 | +12 | 1.0 | an upright 14 × 18 pt oval |

## Gaze and the eyes on a front view

- **Look:** slide both eyes together (`lookX`, `lookY`); the cheeks follow at 0.6 of the offset and the mouth trails 30 ms, so the round face seems to turn (rossark §5.6; huashu cheek parallax).
- **A resting gaze plus one or two glances** in each 6–9 s of idle: glide there in about 500 ms, hold at least 1 s (rossark §4).
- **Blinks:** one every 3–4 s; now and then a double blink (two blinks 260 ms apart). Never during a squash peak. (rossark §4)

## Feelings, as channel settings (rossark §4)

| Feeling | Gaze | Lid at rest | Extra |
|---|---|---|---|
| tired | down or at a screen | 0.3–0.4 | slow blinks, one heavy blink |
| sad | down and away | 0.1 | slow blinks, one slow look up |
| happy | at the viewer and a friend | 0 | `cheek` up once per loop |
| talking | at the listener | 0 | `grin` 0.2–0.5 in syllables (8–14, about 180 ms each) |
| focused | fixed on the task | 0.1 | rare blinks, small saccades |
| curious | to the thing, head tilted 4° | 0 | `wide` 0.2, one slow blink |
