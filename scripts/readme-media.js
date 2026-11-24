#!/usr/bin/env node
// Renders the README's looping motion examples from the sample assets: each frame is drawn by `skac asset frame --out=*.png`, the app's
// own Skia draw code over CanvasKit, while the scene's inputs fire at their times; ffmpeg joins the frames into a looping WebP in
// docs/media. Run: npm run readme:media [name...]. Needs ffmpeg with libwebp_anim.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/cli.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 25;
const BACKGROUND = '#111821';

// Inputs fire in seconds (`--commands`), as in the README's command lines. `scale` draws at that multiple of the artboard for sharp
// edges on high-density screens; the README shows each at its artboard width. Frames are lossless unless a scene sets `quality`.
export const SCENES = [
  { name: 'versus-hud-hit', sample: 'versus-hud', ms: 2400, scale: 1,
    commands: 'leftHealth=0.48@0.3 leftHit@0.3 rightHealth=0.31@1.2 rightHit@1.2 timerOnes=8@1.8' },
  { name: 'game-hud-reload', sample: 'game-hud', ms: 2600, scale: 2,
    commands: 'ammo=1@0.2 health=0.2@0.4 reload@0.9 ammo=6@1.7 health=0.8@2' },
  { name: 'reward-counter-land', sample: 'reward-counter', ms: 2000, scale: 2,
    commands: 'xpLabel="+10 XP"@0.2 land@0.2 xpLabel="+25 XP"@1.1 land@1.1' },
  // An earned moment, from docs/examples: a lamp that squashes, hops, flares and pours out pearls. Its painted glow changes every frame,
  // so it is drawn small and lossy to stay near 400 kB.
  { name: 'lamp-surge', source: 'docs/examples/lamp-surge.motion.json', ms: 2700, scale: 0.3, quality: 70, commands: 'reveal@0.2' },
  // Sprout's painted gradients compress poorly without loss; at quality 95 the dark background stays clean.
  { name: 'sprout-reactions', sample: 'sprout', ms: 3200, scale: 1.5, quality: 95,
    commands: 'correct@0.2 incorrect@1.3 light=0.5@2.2 skip@2.3' },
];

export async function renderScene(scene, out = join(ROOT, 'docs', 'media')) {
  const source = join(ROOT, scene.source ?? join('templates', 'assets', `${scene.sample}.json`));
  const asset = JSON.parse(readFileSync(source, 'utf8'));
  const width = Math.round(asset.artboard.width * scene.scale);
  const height = Math.round(asset.artboard.height * scene.scale);
  const frames = join(ROOT, '.scratch', 'readme-media', scene.name);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const count = Math.round(scene.ms * FPS / 1000);
  for (let i = 0; i < count; i++) {
    const t = Math.round(i * 1000 / FPS);
    await execute(['asset', 'frame', source, `--trace=${t}`, `--commands=${scene.commands}`, `--size=${width}x${height}`,
      `--background=${BACKGROUND}`, `--out=${join(frames, `${String(i).padStart(4, '0')}.png`)}`, '--force',
      ...Object.entries(scene.fonts ?? {}).map(([slot, file]) => `--font=${slot}=${join(ROOT, file)}`)], ROOT);
  }
  const file = join(out, `${scene.name}.webp`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', join(frames, '%04d.png'),
    '-c:v', 'libwebp_anim', ...(scene.quality ? ['-lossless', '0', '-quality', String(scene.quality)] : ['-lossless', '1']),
    '-compression_level', '6', '-loop', '0', file]);
  rmSync(frames, { recursive: true, force: true });
  return { name: scene.name, file, frames: count, width, height, bytes: statSync(file).size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = process.argv.slice(2);
  for (const scene of SCENES.filter(({ name }) => !wanted.length || wanted.includes(name))) {
    console.log(JSON.stringify(await renderScene(scene)));
  }
}
