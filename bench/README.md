# bench: four fixed motion tasks

Each folder holds what the agent sees: `request.md` (the words a person would write) and `Character.spec.json` (what `--check` judges the result by). Everything else comes from the runner.

| task | what it asks | beats in the spec |
|---|---|---|
| `combo` | tap at 4 s: crouch, hop, land, settle | 4, channel and part, one `from_ms` window |
| `idle-loop` | 8 s idle, loops without a jump | breath, drift, sway, blink |
| `glance-blink` | look left, blink on the turn, hold, look back | glance, blink, glance back |
| `overlap` | body and sprout rise together, sprout lags | body, sprout (`overlaps`) |

## What the runner tells the agent

The agent gets `request.md`, the spec file copied to `src/Character.spec.json`, and one sentence naming the parts, channels and composition. Take the names from the spec: the parts are the keys of `parts` (`body`, `sprout`), the channels are the `channel` values of the beats (`stretch`, `squash`, `lid`), and the composition is `Character`. The agent is not told the check ids or the numbers in `open`.

Before the run, empty the starter's scene: `skac create` ships a Character that already performs the `combo` story, so a fresh project passes `combo` untouched. Move `src/Character.tsx` and `src/Character.rig.ts` out and give the agent a Character that draws the parts at rest with no motion.

## Scoring

- **pass@1:** the first `skac Character --check` the agent runs reports `ok`. No retries count. A run that needed a second `--check` to pass is a fail for pass@1 (record it as pass after fixes if you want that number too).
- **Still look at the end.** No check judges beauty (`docs/motion/checks.md` section 4). After `--check` is ok, look at the frames. A pass here means the spec's beats and the rig rules hold, nothing more.
- `loop-seam` runs only when the rig sets `meta.loop`. For `idle-loop` also read the seam in the frames.
- Not judged by the spec: the hold length in `glance-blink`, and how far the sprout lags in `overlap`. Both are in `open`, so look at them.

## Check the specs before a run

```
node bench/check-specs.mjs
```

It loads every `bench/*/*.spec.json` and fails on: an unknown beat key, a beat with no condition (`direction` or `reaches`), `from_ms`/`to_ms` mixed with `after`/`overlaps`, a direction other than up, down, left or right, left or right on a channel beat, a duplicate beat name, `after` or `overlaps` naming a beat that is not in the spec. Give file paths to check one file.
