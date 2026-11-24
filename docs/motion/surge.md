# Surge: an earned moment, made wild

Two registers. **Everyday motion** (interface chrome, a character idling, reacting or walking) keeps the calm budget in `principles` §1, `body` and `interface`: small amplitudes, overshoot 5% at most, one rebound. **An earned moment** is wild. It is a claim, a reward, an unlock, a level or a place cleared, a streak kept: rare, caused by something the person did, and the one place an app can spend delight. "Be wild, not safe" (owner of the Word Quran app, O-8526).

For an earned moment these calm limits do not apply: the 5% overshoot cap, the one-rebound limit, the 8% squash limit and the 0.54 pt/ms burst cap. Both registers keep: Reduce Motion shows the end state with no travel; input is never blocked; the moment lasts about 2.5 s at most; nothing flashes over 3 Hz; and no casino pattern (below).

The numbers are worked ranges from one finished surge: a lamp that squashes, hops, flares and pours out six pearls in 2.26 s. Start there and tune on frames; a value is a starting point, not a law.

## Build it as channels and one trigger

1. One asset, one clip for the moment, one trigger. A one-layer machine: idle, then the moment on the trigger, then idle again at the clip's end (`exit_at` 1). Set the clip's `reducedAt` to the finished still pose.
2. No baked frames. Name every moving number as a channel (about 60 for a rich moment) and bind it to a node property: body height, rock, scale X and Y, flame width, height and tilt, light alpha, a light's clip edge, shadow, and one set of x, y, alpha and scale per pearl and per spark. Each channel is keys `[ms, value, ease]` with `in`, `out` or `inOut` eases, so every peak is a number you can move.
3. Secondary actions overlap the primary. Nothing waits for the previous beat to finish and nothing stops dead; every channel ends in a damped settle.
4. Add an attachment check for parts that must stay joined through the squash and stretch (`attachments: [{from, to, maxDistance}]`). In the lamp, the flame's centre and its halo's centre stay within 6 units.

## The beats

| Beat | What it does | Worked range |
|---|---|---|
| Anticipation | the body squashes and the flame dips before anything leaves | scaleY 0.85 to 0.9 with scaleX 1.08 to 1.12, at 12 to 15% of the clip; flame height dips to about 0.7 |
| Take-off | stretch as it leaves the ground | scaleY 1.1 to 1.15 with scaleX 0.96 to 0.97, at about 20% |
| Hop | out up, in down: a clear arc; the shadow shrinks to about a third at the top | 60 to 100 units at the sheet's scale; 35 to 40% of the clip in the air |
| Landing | a second squash, then damped settles to 1 | scaleY 0.9 to 0.92, scaleX 1.07 to 1.08, settled at 60 to 70% |
| Rock | a damped swing across the body | 5 to 7 swings, for example -3, 7, -10, 7, -3, 1.4, 0 degrees; the flame tilts through its own 5 to 6 swings, 14 degrees down to 4 |
| Flare | the focus of the moment overshoots, then oscillates down | 1.5 to 2.2 times height and 1.5 to 1.8 times width, starting before the body lands; the halo peaks on the same frame |
| Light spill | light pours over a rim and recedes | a clipped glow whose clip edge is itself a channel (`clip` on a group) |
| Burst | the payoff leaves one piece after another | 5 to 8 pieces 40 to 60 ms apart, launched at the hop's peak: each rises (`out`), arcs and falls (`in`) to its own fanned landing x, fades in over about 100 ms and out at the end |
| Sparks | small stars on top | 6 to 8, 40 to 50 ms apart: scale 0.3 to 1.2 to 0.3, alpha 0 to 0.9 to 0, drifting up and out |

Peaks overlap but one channel's peak never shares a frame with another's (`body`, peaks never stack). Shadow, light and glow follow the body, not the clock.

## How top apps do it

What these sources show, and what they do not. Only the first two rows state a fact; the rest are read from a single still, so they give composition, never timing.

| Source | What it shows |
|---|---|
| Duolingo, "World character visemes" (blog.duolingo.com/world-character-visemes), from a search summary, not read in full | an animation state for each general pose of a character in a lesson, and separate states only for its mouths |
| Rive, "Creative technologists: Duolingo's solution to the designer to developer handoff" (rive.app/blog), from a search summary | Duolingo hires people who optimise designs with the animators and tell engineers what to change; no durations or sizes stated |
| A Duolingo design-studio post on LinkedIn (secondary source) | motion designers handle streak updates, lesson completions and leaderboard changes, and hand engineers the file structure, state machines, inputs and triggers |
| Royal Match, "Level 3, Well Done" win modal (Appllama still, 24 Nov 2026) | one hero object (a large star on a cushion) at the centre of a modal that overlaps the dimmed board; about fifteen small four-point sparkles of three or four sizes spread round it, none in front of the title; the reward counter and moves stay visible above, so the payoff lands on a number the person is watching. Estimate from one frame: the sparkles are staggered, not simultaneous |
| Mondly, "Lesson Complete" (Appllama metadata) | a result badge with radial glow rings and stat cards below; the library lists these elements and gives no timing |
| Candy Crush Saga, Duolingo streak and learning path screens (Appllama stills) | stills of the resting state only; they show where a moment ends (the new level node, the streak number), not how it moves |

No source found for Duolingo's or the games' durations, sizes or sound sync, so none are given. What the Royal Match still supports: one hero element carries the moment; the board behind dims and stays visible; the sparks are small, many and of a few sizes, not one big burst. The rest of the recipe (stagger, hop, flare, settle, the numbers above) comes from the lamp, which was tuned on frames. Take methods only; do not copy another app's art, characters or look.

## Left out on purpose (casino patterns)

Random or variable rewards, slot reels, spinning wheels, coin showers, near-miss displays and a payoff the person did not earn are not part of this register. An earned moment shows a fixed payoff for a real cause. Pieces of the burst count what was earned and never more.

## Checks

- `skac asset check` on the file; `skac compare` on a render (`checks`); the frame list and a read at real speed.
- The calm rig rules (`skac/overshoot`, `skac/speed-cap`, `skac/no-bouncy-spring`) judge against the calm budget and fail wild motion by design. In a project that ships earned moments, set them in `skia-motion.json` (`"rules": { "skac/overshoot": "off" }`) and write the reason in the plan. Keep every other rule on.
- The moment plays once per cause, never as an idle loop, and the screen stays tappable while it plays.
