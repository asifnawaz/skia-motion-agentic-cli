# Notices

The motion docs in `docs/motion` and the files in `templates/motion` adapt code and rules from two MIT-licensed skills. Their licences follow, copied whole.

| This file | Adapts |
|---|---|
| templates/motion/motion.ts | rossark-motion-skill `templates/react-native/motion.ts` (track, flow, seg, wave, loop, bell, seeded, the curves); huashu-art-motion `scripts/engine/lib/motion.js` (`MO.bezier` solver, `MO.spring`) |
| templates/motion/clock.app.ts | rossark-motion-skill `templates/react-native/motion.ts` (useLoopClock, useOneShotClock) |
| templates/motion/liveFace.tsx | rossark-motion-skill `templates/react-native/liveFace.tsx` (lid, cheek, closed line, happy arc, lid clip); huashu-art-motion `scripts/engine/lib/toon.js` (the expression set: shock, happy, worry, mouth shapes) |
| docs/motion/principles.md, body.md | rossark-motion-skill `SKILL.md` §1–§8, §11 and `MOTION.md` |
| docs/motion/faces.md, idle.md | rossark-motion-skill `SKILL.md` §4–§5; huashu-art-motion `scripts/engine/lib/toon.js`, `rig_huashu.js`, `references/04-纯代码绘制.md`, `07-正面经验.md`, `镜头语言.md` |
| docs/motion/anticipation.md, body.md (timing tables) | ideas from LottieFiles motion-design (`director/disney-principles.md`, `reference/timing-easing-tables.md`, `patterns/entrance-exit.md`), written in our own words; that skill ships no licence file, so none of its text is copied |
| templates/motion/clock.remotion.ts, docs/motion/remotion-and-app.md | the sRGB fix for Skia's WebGL drawing buffer, written for this package |

## rossark-motion-skill

MIT License

Copyright (c) 2026 rossark0

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## huashu-art-motion

MIT License

Copyright (c) 2026 alchaincyf (花叔 · 花生)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
