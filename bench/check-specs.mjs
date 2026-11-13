// node bench/check-specs.mjs [file...]  loads every bench/*/*.spec.json and rejects a malformed spec before a run.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = ['name', 'channel', 'part', 'from_ms', 'to_ms', 'direction', 'after', 'overlaps', 'reaches'];
const here = dirname(fileURLToPath(import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(here, { withFileTypes: true }).filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(here, d.name)).filter((f) => f.endsWith('.spec.json')).map((f) => join(here, d.name, f)));

const errors = [];
for (const file of files) {
  const bad = (m) => errors.push(`${file}: ${m}`);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const beats = spec.beats || [];
  if (!beats.length) bad('no beats');
  const names = new Set(beats.map((b) => b.name));
  if (names.size !== beats.length) bad('beat names are not unique');
  for (const b of beats) {
    const at = (m) => bad(`beat "${b.name}": ${m}`);
    for (const k of Object.keys(b)) if (!KEYS.includes(k)) at(`unknown key "${k}"`);
    if ((b.channel === undefined) === (b.part === undefined)) at('needs exactly one of channel or part');
    if (b.direction === undefined && !b.reaches) at('has no condition (direction or reaches)');
    if (b.direction !== undefined) {
      if (!['up', 'down', 'left', 'right'].includes(b.direction)) at(`direction "${b.direction}" is not up, down, left or right`);
      else if (b.channel !== undefined && !['up', 'down'].includes(b.direction)) at('a channel beat takes up or down only');
    }
    if ((b.from_ms !== undefined || b.to_ms !== undefined) && (b.after !== undefined || b.overlaps !== undefined)) at('mixes from_ms/to_ms with after/overlaps');
    for (const k of ['after', 'overlaps']) if (b[k] !== undefined && !names.has(b[k])) at(`${k} "${b[k]}" is not a beat in this spec`);
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`ok: ${files.length} specs`);
