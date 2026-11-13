import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseCommands } from './args.js';
import { loadConfig } from './config.js';
import { boxProbe, check, lint, pixelProbe, stats, story } from './blind.js';
import { compareVideos } from './compare.js';
import { doctor } from './doctor.js';
import { docsCommand } from './docs.js';
import * as lintModule from './lint.js';
import { inspect, add } from './project.js';
import * as rigModule from './rig.js';
import * as rulesModule from './rules.js';
import { render, screenshot, stillPixels, verify } from './render.js';
import { createProject, samples } from './scaffold.js';
import { schema } from './schema.js';
import { update } from './update.js';
import { CliError, errorDoc, fail, toJson } from './util.js';

const SPEC = {
  bool: ['verify', 'screenshot', 'render', 'sheet', 'force', 'help', 'stats', 'story', 'check', 'fix', 'version'],
  str: ['probe', 'probe-box', 'at','advance', 'commands', 'out', 'scale', 'size', 'fps', 'frames', 'event', 'expect', 'baseline',
    'search', 'as', 'entry', 'root', 'out-dir', 'gl'],
  list: ['docs-dir'],
};

// What the blind-mode commands in blind.js compose; unit tests pass stubs instead.
const DEPS = { lint: lintModule, rig: rigModule, rules: rulesModule, compare: { compareVideos }, pixels: { stillPixels } };

const version = () =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const number = (text, flag) => {
  const n = Number(text);
  if (text === undefined || !Number.isFinite(n) || n < 0) fail(`--${flag} needs a number`, `like --${flag}=1.5`);
  return n;
};

/** Run one command and return its JSON document. */
export const execute = (argv, cwd = process.cwd()) => {
  const { pos, flags } = parseArgs(argv, SPEC);
  if (flags.version) return { ok: true, name: 'skac', version: version() };
  const cfg = loadConfig(cwd, { entry: flags.entry, root: flags.root, out: flags['out-dir'], docs: flags['docs-dir'], gl: flags.gl });
  const [first, ...rest] = pos;
  if (!first || flags.help) {
    return {
      ok: true, name: 'skac', version: version(),
      commands: ['--version', 'doctor', 'docs [topic [section]] [--search text]', 'create [dir]', 'add <Name>', 'samples [name] [dir]', 'schema [Name]',
        'inspect [Name]', 'compare <mp4...>', 'lint [files...] [--fix]', 'update [--force] [--check]',
        '<Name> --stats | --story | --check  (blind mode: no image)',
        '<Name> --probe=x,y[;x,y] --at=t  (colour at points in pt, AARRGGBB, as rive)',
        '<Name> --probe-box=x,y,w,h --at=t  (the box\'s top 8 colours by pixel count, with share and bbox in pt)',
        '<Name> --verify | --screenshot --at=0.5,4.0 [--sheet] | --render | --commands "tap@4.0"'],
      next: ['skac docs blind', 'skac doctor'],
    };
  }
  switch (first) {
    case 'doctor': return doctor(cfg, version());
    case 'docs': return docsCommand(cfg, { topic: rest[0], section: rest.slice(1).join(' ') || undefined, search: flags.search, as: flags.as });
    case 'create':
    case 'init': return createProject(rest[0], { force: flags.force });
    case 'add': return add(cfg, rest[0], { size: flags.size, fps: flags.fps, frames: flags.frames });
    case 'samples': return samples(rest[0], rest[1], { force: flags.force });
    case 'schema': return schema(cfg, rest[0]);
    case 'inspect': return inspect(cfg, rest[0]);
    case 'lint': return lint(cfg, rest, { fix: flags.fix }, DEPS);
    case 'update': return update(cfg, { force: flags.force, check: flags.check });
    case 'compare':
      return compareVideos(rest, {
        event: flags.event === undefined ? undefined : number(flags.event, 'event'),
        expect: flags.expect,
        baseline: flags.baseline,
      });
    default: break;
  }
  return composition(cfg, first, flags);
};

const composition = (cfg, name, flags) => {
  const cmd = flags.commands ? parseCommands(flags.commands) : { events: [], captures: [] };
  const times = [
    ...(flags.at ? flags.at.split(',').map((t) => number(t.trim(), 'at')) : []),
    ...(flags.advance !== undefined ? [number(flags.advance, 'advance')] : []),
    ...cmd.captures,
  ].filter((t, i, a) => a.indexOf(t) === i);
  const wantsShots = flags.screenshot || (flags.commands && cmd.captures.length > 0);
  const events = cmd.events;
  const event = flags.event === undefined ? undefined : number(flags.event, 'event');
  if (flags.probe !== undefined) {
    if (times.length > 1) fail('--probe reads one time', 'pass one --at=<seconds>');
    return pixelProbe(cfg, name, { points: flags.probe, at: times[0] ?? 0, events }, DEPS);
  }
  if (flags['probe-box'] !== undefined) {
    if (times.length > 1) fail('--probe-box reads one time', 'pass one --at=<seconds>');
    return boxProbe(cfg, name, { box: flags['probe-box'], at: times[0] ?? 0, events }, DEPS);
  }
  if (flags.stats) return stats(cfg, name, { events }, DEPS);
  if (flags.story) return story(cfg, name, { events }, DEPS);
  if (flags.check) return check(cfg, name, { events }, DEPS);
  if (flags.verify) return verify(cfg, name, { events });
  if (wantsShots) return screenshot(cfg, name, { times, sheet: flags.sheet, events });
  if (flags.render || flags.commands) {
    return render(cfg, name, { out: flags.out, scale: flags.scale === undefined ? 2 : number(flags.scale, 'scale'), events, event });
  }
  const doc = inspect(cfg, name);
  doc.next = [`skac ${name} --check`, `skac ${name} --story`, `skac ${name} --verify`, `skac ${name} --screenshot --at=0.5,4.0 --sheet`, `skac ${name} --render`, `skac ${name} --commands "tap@4.0"`];
  return doc;
};

/** The entry point: one JSON document on stdout, exit 1 when it says ok:false or an error was thrown. */
export const main = (argv) => {
  let doc;
  try {
    doc = execute(argv);
  } catch (e) {
    if (!(e instanceof CliError)) {
      process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
      doc = { ok: false, error: `unexpected failure: ${e && e.message}`, hint: 'this is a bug in skac; the stack is on stderr' };
    } else doc = errorDoc(e);
  }
  process.stdout.write(toJson(doc));
  process.exitCode = doc.ok === false ? 1 : 0;
};
