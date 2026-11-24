# Interface motion: continuity in change, stillness at rest

Read this for any interface frame, screen, card, button or list. Declare the scene `meta.kind: 'interface'` (the default is `'character'`).

## The rule (owner O-4578, O-4622, 9 Nov 2026; O-5619 to O-5621, 13 Nov 2026)

An app change feels continuous, never a sudden change of screen. The character rules (never frozen, a slow breath in every hold) do not apply to an interface.

1. **Place.** What is on both sides of a change travels from where it was to where it goes. New things arrive from their cause; leaving things go somewhere. Two whole states never cross-fade. (`skac/crossfade`, `skac/long-fade`)
2. **Speed.** No move starts or stops at full speed, and nothing jumps between frames. (`skac/abrupt`, `skac/speed-cap` at the interface cap of 2.1 pt/ms)
3. **Sequence.** Beats overlap; a stall between two beats of one change reads as two changes. (`skac/dead-hold` inside each change: beats that share `change`)
4. **Rest.** Once settled, an interface holds still: at most one slow ambient element (a mascot, a live glow), never text, frozen under reduced motion. `skac/dead-hold` does not judge the rest after a change, and `skac/idle-cadence` does not run.

**The example: Welcome** (word-quran `WelcomeScreen.tsx`). On a first launch the boot seal does not give way to Welcome: it starts on the boot seal's measured centre and size, travels up and grows into the medallion over 600 ms on inOut cubic (`CUBIC_IN_OUT` in motion.ts, re-exported by moves.ts), and the title rises once the seal has passed its place (330 ms in). One motion, no cut. The Interface sample's first beat is this hand-over written as a skac scene; it checks clean.

**Calm is not a fade.** Everyday interface motion is calm: small amplitudes, at most 5% overshoot and no noise (principles §1). An earned moment is the other register and is not held to that budget (`skac docs motion/surge`). When a product rule or a study shows a cross-fade, carry instead and say why in the plan.

**Moves take linear progress.** `carry`, `morphBox`, `flyInto`, `roll`, `enter` and `exit` ease inside. Pass them the linear progress of their window, `Math.min(1, Math.max(0, (ms - a) / (b - a)))`, never `seg(ms, a, b)` (which already eases: the move would ease twice).

Every move below is a worklet in `templates/motion/moves.ts` (`points.ts` and `paths.ts` for point sets and paths) with its numbers in one `MOVE` object. A move returns plain numbers, so it drives a Skia drawing or a Reanimated style alike.

## The moves, by moment

The last column names onetake's moves and applies only when the project loads `lib/motion.js` through `"libs"` (`skac docs commands`, Libs); the other columns name skac's own moves, which stay for projects without it. In the app import the worklet build by name: `import { morphRect } from './motion/lib/onetake.worklet'`. OM moves take seconds and return `{x, y, w, h, r}` and the like; keep an OM move's start and end inside the beat's window.

| Moment | Move | Duration (`MOVE`) | Do not | OM, when the project loads onetake |
|---|---|---|---|---|
| Tap feedback | `press(msSinceDown, msSinceUp)` | down in about 60 ms, back over `press` 130 ms, scale `pressScale` 0.97, at most 1% overshoot | scale the drawing inside the button; fade the button | `OM.press(t, tc)` (`s`, `active`) |
| A button opens a sheet; a chip becomes a card | `morphBox(from, to, p)` on rounded boxes `{x, y, w, h, r}` | `handover` 560 ms | slide a sheet in from nowhere while the button stays | `OM.morphRect(t, t0, t1, A, B)` on `{x, y, w, h, r}` (one rect becomes the other), or `OM.iris(t, t0, t1, cx, cy)` to open the sheet's world from the tap point |
| A card goes to a new screen (list card to detail) | `carry(from, to, p)`, a slight arc on `CUBIC_IN_OUT` | `handover` 560 ms; the rest of the frame trails it through `follow(table, ms)` (the default spring lags 89 ms, `lagMs` 90) | remove the card and draw a copy; crossfade the two screens | `OM.morphRect` for the card, `OM.zoomThrough(t, t0, t1, target)` when one card among many is the next screen |
| A label changes meaning | the shape around it morphs (`morphBox`), the text moves whole | `feedback` 200 ms | crossfade the old and new label | `OM.morphRect` on the shape around it |
| A list arrives | `enter(p)` per row, started by `staggerFrom(i, positions, causeIndex, ms, start)` | `entrance` 380 ms, `staggerMs` 60 ms between rows | fade every row at once | `OM.maskRise(t, t0, i)` per line, `OM.wordRise(t, t0)` per word, `OM.popIn(t, t0)` per card |
| An item is collected into a counter | `flyInto(from, to, p)`, then `contact(msSinceArrival)` on the counter | `entrance` 380 ms, contact squash `contactSquash` 6% back in `contactMs` 200 ms | make the item vanish and the counter tick | `OM.hop(t, t0, t1, from, to)` for the flight, `OM.impact(t, tHit)` for the landing, `OM.gather(t, t0, t1, i, n, from, to)` for many |
| A check completes | `drawOn(path, p)` (a path trimmed to `[0, p]`) | `feedback` 200 ms to `entrance` 380 ms | pop it in with opacity | `OM.tick(t, tl)` (pops from 0.8 when the line is reached) |
| A group follows its leader into place (a row behind its first tile, a badge behind a card) | `followTable(leader, durationMs)` once, then `follow(table, ms)` per child each frame (`follow.ts`; reels `dynamics.js` Follower). Default `FOLLOW`: omega 18, zeta 0.8, read 90 ms ahead: 1.5 % overshoot (cap 5 %), lags 89 ms | the leader's own `handover` 560 ms; each child may use its own omega (lower = later) | build the table inside a worklet or per frame (the caller builds it once); a zeta under 0.69 (overshoots past 5 %); a delayed copy of the leader | none |
| Pearls land one at a time (a purse, a bar of ticks) | `drip(i, ms, t0, t1, n, fromY, toY)` per piece: falls under `COUNT.dripAccel` 3200 pt/s^2, then a ring (`ring`, `fade`); `dripLand` is when piece i lands; `contact` on the target at that time (`counts.ts`; reels `numbers.js` `drip`, `dripLand`) | pieces `dripLand`-spaced across the window; one fall about 0.4 s for 300 pt | land all at once; fade each in | `OM.hop` and `OM.gather` for a flight, not a fall |
| A streak's days fill (a week, a month of squares) | `dayHead(n, ms, a, b)` for the day filling, `dayCell(i, n, cols, ms, a, b)` for each square: `arrive` 0..1, `glow`, `tone` (`counts.ts`; reels `numbers.js` `dayWall`) | the fill window you set; a square arrives over 550 ms before it lights | light every square at once; draw the days dark and switch them on | none |
| A heart or a live pulse | `beat(ms, t0, bpm)` 0..1, lub-dub; scale it by at most 0.05 (`counts.ts`; reels `numbers.js` `beat`) | one beat per 60000 / bpm ms (70 bpm: 857 ms) | scale past 5 %; a loop that restarts the pulse | none |
| A total rolls up when it first appears | `odometerDigit(d, di, digits, p)` per digit strip: ease-out cubic, the leftmost strip turns most (`counts.ts`; reels `numbers.js` `odometer`) | the reels roll 1.5 s | use it for a number that changes on screen: it starts at full speed (`roll`, below, starts and stops eased) | `OM.maskRise(t, t0, i)` |
| A number changes | `roll(from, to, p)`: each digit place rolls, the rightmost fastest | `entrance` 380 ms | fade the old number out and the new one in | `OM.maskRise(t, t0, i)`: the new number rises into place from behind a clip |
| A screen changes | `carry` the element that exists on both; `exit(p)` the rest and `enter(p)` the new at `exitShare` 70% of the entrance | `handover` 560 ms | a full-screen crossfade | `OM.morphRect` or `OM.zoomThrough` for the element on both; `OM.camera(t, keys)` with `OM.view` for one continuous world |
| A word becomes a number | `morphPoints(A, B, p, { path, stagger, seed })` on point sets made with `fillPoints` or `pathPoints`; sort once with `sortPoints` | `handover` 560 ms | crossfade two drawings of the text | `OM.morphRect` on the plate around it; `OM.ripple(t, t0)` to end a flood on the new scene |

`enter` and `exit` return `{scale, opacity, y}` with opacity done in the first `fadeMax` 250 ms and the scale or travel carrying the rest. They are the fade you may use, and they pass `--check`. Fall-backs for a reveal from a tap point: `revealRadius(origin, box, p)`.

Every OM move that names onetake's `ease` (`morphRect`, `iris`, `zoomThrough`, `hop`, `gather`, `camera`, `whip`, `ripple` and others) captures it in the worklet build, and `ease` refers to itself: no device run has shown Reanimated carrying it to the UI thread yet (`skac docs commands`, Libs).

**One home per function.** skac's moves and onetake's overlap in purpose, not in code, and each pair is kept for now; the table's last column says which OM move covers the same moment. Calling OM from moves.ts waits on how onetake reaches every project, which the lead owns. The pairs differ in more than packaging:

- `morphBox` and `OM.morphRect`: the same lerp of `{x, y, w, h, r}`; morphBox takes linear `p` in a pt frame on `CUBIC_IN_OUT` (passes skac/abrupt), morphRect takes seconds on `ease.expoOut` (starts at full speed).
- `press` and `OM.press`: ours is a press-and-release scale in ms (down 0.97, back with at most 1% overshoot); OM's is a spring dip from one contact time. Different moves.
- `contact` and `OM.impact`; `flyInto` and `OM.hop`; `revealRadius` and `OM.iris`: same moments; ours are in pt and ms and capped by the owner's rules (6% squash, no full-speed start), OM's in a 1920 px frame and seconds.
- `settle` (ours: a value that arrives and stays) and `OM.settle` (the settling time of a spring): same name, different things.
- The cubic curves have one home, motion.ts (`CUBIC_IN_OUT`, `CUBIC_OUT`, `CUBIC_IN`); moves.ts re-exports `CUBIC_IN_OUT` and points.ts imports them, so no copy remains.
- points.ts is checked against the reels kit it was ported from by a golden test (`test/unit/points-reels.test.js`, against `reels/_kit/morph.js` and `pixelmotion.js`): every morph path but spiral and orbit, ten of thirteen arrivals and every way out give the same points. Kept different on purpose: spiral and orbit turn by sin(pi e) so a point leaves from A (the reels' start turned, off A); vortex lands round; drop rebounds once and burst overshoots at most 5% (owner caps); glitch is not ported; reverse keeps the arrival's size.

## Earned moments: the four phases

A reward, a completion or a first arrival (rare moments, principles §5.1) may take four phases in order: anticipate (`anticipate(p, amount)`, a small dip against the move), move (a carry or a morph), land (`settle(p, overshoot)`), then rest (the idle layer). Routine changes keep overshoot 0 and skip anticipation. The calm register lands with one overshoot of at most `overshootMax` 5%; an earned moment lands with the damped multi-rebound settle and the larger amplitudes in `skac docs motion/surge`, which also lists the wild register's beats and checks.

Hold the finished pose 0.5 to 1 s before the next change, so the person sees what was earned. A return to rest needs a cause as much as the move did: a counted element that slides back by itself reads as a rewind. A part that has landed is not drawn again, and a moving part is never painted with what lies under it on screen (that is a fade in disguise); what it landed on carries the settle.

## Carry rule

If an element exists before and after the change, it is the same element in the rig: one set of channels, `cardX`, `cardY`, `cardW`, `cardH`, that goes from where it was to where it is, and one part, so `--check` can see it travel. Write each move's fields as channels named `<element><Field>`:

```ts
const p = Math.min(1, Math.max(0, (ms - 400) / 560)); // linear: carry eases inside
const c = carry(listBox, detailBox, p);
channels: { cardX: c.x, cardY: c.y, cardW: c.w, cardH: c.h },
parts: { card: { x: c.x, y: c.y, w: c.w, h: c.h } },
```

Map each opacity channel in `meta.opacity` to the channels or parts that carry the same element:

```ts
opacity: { rowsOpacity: ['rowsScale', 'rowsY'], cardOpacity: ['card'] }
```

- `skac/long-fade` (warn): an opacity channel goes from 0.05 or less to 0.95 or more (or back) in one run longer than 250 ms. Finish the opacity inside 250 ms and let scale or travel carry the rest.
- `skac/crossfade` (warn): a boundary is one opacity channel falling through 0.5 while another rises through 0.5 within 150 ms. It is carried when some part on both sides travels 2% of the frame's diagonal or changes size by 10% across the 400 ms around it, else it is bare. This is the carried test of word-quran-reels `core/render/carry.mjs` (lines 62-68), itself onetake's continuity check, ported to rig parts. `enter` and `exit` alone (8 to 12 pt, 6% scale) do not carry a boundary: carry the element on both sides.
- `skac/abrupt` (warn, interfaces): the KINK half of word-quran-reels `core/render/pathcheck.mjs` (owner O-2166) on each part's centre at 30 fps: a change of speed over 12/1920 of the long side and over half the speed around it, which is a start or stop at full speed. pathcheck's JUMP is `skac/speed-cap` here (a move over the cap in one frame is a speed over the cap). A part listed under an opacity channel is not judged while that opacity is under 0.5.
- A scene without `meta.opacity` skips long-fade and crossfade; the `counts` in `--check` show `checked: false`.

## Native text in an app

In an app, words are usually native text (Urdu and Arabic shaping, accessibility, selection), so a word cannot morph on the canvas. Text moves whole: travel or scale, with a fade of 250 ms at most. The shapes around it carry the morph: the plate, the outline, the icon, a number drawn as paths, a point cloud. A word becoming a numeral by points is for video, or for text drawn as paths; in the app it stays native text and the plate beneath it morphs.

A paths morph needs both paths to share their verbs. `morphPath(a, b, p)` throws, naming the move, when they do not; draw both from the same command list, or use `morphPoints`. The throw happens where the path is drawn, so `--render` and `--screenshot` fail with it. `--check` samples the rig in Node without Skia, so declare each morph in `meta.morphs` as the two SVG strings the draw builds it from (`morphs: { icon: { from: ICON_A, to: ICON_B } }`): `skac/morph-path` (error) compares their Skia verbs and fails before any render. An arc counts as one verb there; Skia makes it a sweep-dependent number of conics, so morph between arcs only from the same command list.

**Where the path moves run** (a one-frame render under Remotion's CanvasKit, 13 Nov 2026): `drawOn` (`Skia.Path.Trim`), `pathPoints` (`ContourMeasureIter`), `fillPoints` (`contains`) and `morphPath` run in video and in the app. `Skia.Path.MakeFromText` is **app only**: on the web it throws "Not implemented on React Native Web". In a video, make a word's outline an SVG path (a font tool, or the app's `MakeFromText` once) and pass it to `fillPoints` or `pathPoints`.

`morphPoints` returns `size` as a multiplier of the dot's base radius: draw `drawCircle(x, y, base * size)`.

## Sample

`skac samples interface` writes an interface scene: the Welcome hand-over (the seal carried into the medallion, the title rising after it), the seal carried on into a header badge as the list arrives, a list card carried into a detail frame, a button pressed and morphed into a sheet, a check that draws on, a count that rolls and a word whose points morph into a numeral, then rest. Its drawing lives in `Interface.draw.ts`, so `skac Interface --export <app-dir>` copies it into an app.
