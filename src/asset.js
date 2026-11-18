import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, constants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import { buildSync } from 'esbuild';
import { parseCommands } from './args.js';
import { assetGuide } from './asset-guide.js';
import { previewHTML } from './asset-preview.js';
import { applyDefaultFont } from './default-font.js';
import { PACKAGE_ROOT } from './docs.js';
import { fail } from './util.js';

const SAMPLES = {
  'game-hud': 'Health and ammo bindings, low-health feedback, and a reload cue',
  sprout: 'Mascot reactions with a host-controlled highlight',
  'versus-hud': 'Two fighter health and super meters, a round timer, and feathered hit flashes',
};

const USAGE = [
  'skac asset guide [workflow|format|hud|character|lighting|feathering|images|mesh|masking|attachments|layout|playback|migrate]',
  'skac asset sample [game-hud|sprout|versus-hud] [output.json]',
  'skac asset image <file.png|file.webp> [--size=<maxWidth>x<maxHeight>]',
  'skac asset resource <font.ttf|font.otf|cue.wav|cue.mp3|cue.m4a|cue.aac>',
  'skac asset check <file> [--size=360x640] [--trace=0:2400:16] [--commands=cue@0]',
  'skac asset trace <file> --trace=0,250,800 --commands "health=0.2@0.1 reload@0.25"',
  'skac asset frame <file> --trace=250 [--size=1200x240] [--out=<frame.svg>]',
  'skac asset preview <file.skmotion> [--artboard=<name>] [--size=1200x240] [--out=<preview.html>] [--force]',
  'skac asset types <file> [--artboard=<name>] [--out=<bindings.d.ts>] [--force|--check]',
  'skac asset pack <file> [--out=<name.skmotion>] [--force]',
];
let runtime;

function assetRuntime() {
  if (!runtime) {
    // The CLI checks its own trusted runtime bundle. Asset text goes through JSON.parse in that runtime.
    const { outputFiles } = buildSync({
      entryPoints: [join(PACKAGE_ROOT, 'runtime', 'asset-trace.ts')],
      bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18',
    });
    const module = { exports: {} };
    compileFunction(outputFiles[0].text, ['module'])(module);
    runtime = module.exports;
  }
  return runtime;
}

function describe(asset) {
  return {
    name: asset.name,
    schema: asset.schema,
    artboard: { width: asset.artboard.width, height: asset.artboard.height },
    channels: asset.channels,
    values: asset.machine.values ?? {},
    clips: Object.fromEntries(Object.entries(asset.clips).map(([name, clip]) => [name, clip.ms])),
    layers: asset.machine.layers.map(({ name, states }) => ({ name, states: Object.keys(states) })),
    markers: asset.markers ?? [],
  };
}

function sample(name, output, cwd, force) {
  if (!name) return { ok: true, samples: SAMPLES, commands: USAGE };
  if (!Object.hasOwn(SAMPLES, name)) fail(`unknown asset sample "${name}"`, 'run skac asset sample to list the examples');
  const path = resolve(cwd, output ?? `${name}.motion.json`);
  if (!force && existsSync(path)) fail(`destination exists: ${path}`, 'pick another destination or pass --force');
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, 'templates', 'assets', `${name}.json`), path, force ? 0 : constants.COPYFILE_EXCL);
  return { ok: true, file: path, next: [`skac asset check "${path}"`, `skac asset pack "${path}"`] };
}

function dimensions(value) {
  const size = /^(\d+)x(\d+)$/i.exec(value)?.slice(1).map(Number);
  return size?.every((side) => side >= 1 && side <= 4096) ? size : undefined;
}

function resizeImage(data, format, size, bounds) {
  const scale = Math.min(1, bounds[0] / size.width, bounds[1] / size.height);
  if (scale === 1) return data;
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const codec = format === 'png' ? ['-c:v', 'png', '-pix_fmt', 'rgba']
    : ['-c:v', 'libwebp', '-pix_fmt', 'bgra', '-lossless', '1'];
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'image2pipe', '-c:v', format, '-threads', '1', '-i', 'pipe:0',
    '-vf', `scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', '-threads', '1',
    ...codec, '-f', 'image2pipe', 'pipe:1',
  ], { input: data, maxBuffer: 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    fail('could not resize the image', result.error?.code === 'ENOENT'
      ? 'install ffmpeg and put it on PATH'
      : 'use a static image, a smaller requested size, and an ffmpeg build with PNG and libwebp support');
  }
  return result.stdout;
}

function embedImage(path, requestedSize) {
  const format = extname(path).slice(1).toLowerCase();
  if (format !== 'png' && format !== 'webp') fail('expected a PNG or WebP file', 'convert the painting to PNG or WebP');
  const bounds = requestedSize === undefined ? undefined : dimensions(requestedSize);
  if (requestedSize !== undefined && !bounds) fail('invalid image size', 'use maximum dimensions from 1 to 4096, like --size=160x160');
  const limit = assetRuntime().MAX_ASSET_BYTES * 3 / 4;
  let data;
  try {
    const stat = statSync(path);
    const maxBytes = bounds ? 32 * 1024 * 1024 : limit;
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`expected a regular file up to ${maxBytes / 1024} KiB`);
    data = readFileSync(path);
  } catch (error) {
    fail(`could not embed ${path}: ${error.message}`, 'use --size to resize large artwork before embedding');
  }
  let size = assetRuntime().imageFileSize(format, data);
  if (!size || size.width < 1 || size.height < 1 || size.width * size.height > 16 * 1024 * 1024) {
    fail('invalid embedded image header or dimensions', 'use a static PNG or WebP up to 16 Mi pixels');
  }
  if (bounds) {
    data = resizeImage(data, format, size, bounds);
    size = assetRuntime().imageFileSize(format, data);
  }
  if (!size || size.width > 4096 || size.height > 4096 || data.length > limit) {
    fail('image exceeds embedded image limits', 'use smaller dimensions with --size or convert to WebP');
  }
  const uri = `data:image/${format};base64,${data.toString('base64')}`;
  return { ok: true, bytes: data.length, ...size, rgbaBytes: size.width * size.height * 4, uri };
}

function readAsset(path, authoring) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read ${path}`, 'pass a JSON source or a .skmotion file');
  }
  try {
    const runtime = assetRuntime();
    const file = authoring && extname(path).toLowerCase() !== '.skmotion'
      ? runtime.parseAssetSource(source) : runtime.parseAssetFile(source);
    return { file, source };
  } catch (error) {
    fail(error.message, 'see skac asset sample for an example of skac.asset/1', { file: path });
  }
}

function embedResource(path) {
  const types = {
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  };
  const type = types[extname(path).toLowerCase()];
  if (!type) fail('unsupported resource type', 'use a TTF or OTF font, or a WAV, MP3, M4A or AAC sound');
  const limit = Math.floor(assetRuntime().MAX_ASSET_BYTES * 0.75) - 32;
  let bytes;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error(`expected a regular file from 1 to ${limit} bytes`);
    bytes = readFileSync(path);
  } catch (error) {
    fail(`could not embed ${path}: ${error.message}`, 'pass a small font or audio clip');
  }
  if (bytes.length < 1 || bytes.length > limit) fail('resource size changed while reading', 'retry with a stable source file');
  if (type.startsWith('font/') && !assetRuntime().hasFontHeader(bytes)) {
    fail('invalid TTF or OTF font header', 'use a valid font file');
  }
  return { ok: true, bytes: bytes.length, uri: `data:${type};base64,${bytes.toString('base64')}` };
}

function traceTimes(spec) {
  const range = /^(\d+):(\d+):(\d+)$/.exec(spec.trim());
  if (range) {
    const [, first, last, increment] = range.map(Number);
    const count = Math.ceil((last - first) / increment) + 1;
    if (Number.isSafeInteger(increment) && increment > 0 && first <= last && last <= 60000 && count <= 500) {
      return Array.from({ length: count }, (_, i) => Math.min(last, first + i * increment));
    }
  } else {
    const tokens = spec.split(',');
    if (tokens.length <= 500 && tokens.every((t) => /^\d+(\.\d+)?$/.test(t.trim()) && Number(t) <= 60000)) {
      return tokens.map(Number);
    }
  }
  fail('invalid asset trace times', 'use up to 500 times in ms from 0 to 60000, comma-separated or as start:end:step');
}

function trace(asset, flags) {
  const times = traceTimes(flags.trace ?? '0');
  const sides = flags.size === undefined ? undefined : dimensions(flags.size);
  if (flags.size !== undefined && !sides) fail('invalid viewport size', 'use two dimensions from 1 to 4096, like --size=360x640');
  const viewport = sides ? { width: sides[0], height: sides[1] } : undefined;
  const cmd = flags.commands ? parseCommands(flags.commands) : { events: [], captures: [] };
  if (cmd.captures.length) fail('asset trace does not take screenshots', 'remove screenshot commands and pass times with --trace');
  if (cmd.events.length > 1000 || cmd.events.some(({ at }) => !Number.isFinite(at) || at > 60)) {
    fail('invalid asset trace event times', 'use up to 1000 events, between 0 and 60 seconds');
  }
  try {
    return assetRuntime().traceAsset(asset, times, cmd.events, Boolean(flags.reduced), viewport);
  } catch (error) {
    fail(error.message, 'run skac asset check <file> to inspect supported inputs');
  }
}

function writeOutput(path, content, force) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    fail(`cannot write ${path}`, error.code === 'EEXIST' ? 'pick another destination or pass --force' : error.message);
  }
}

function bindingsDeclaration(asset) {
  const values = Object.entries(asset.machine.values ?? {}).map(([name, { type, options, bind }]) => {
    const fields = [`readonly type: ${JSON.stringify(type)}`];
    if (options) fields.push(`readonly options: readonly ${JSON.stringify(options)}`);
    if (bind) fields.push(`readonly bind: ${JSON.stringify(bind)}`);
    return `    readonly ${JSON.stringify(name)}: { ${fields.join('; ')} };`;
  });
  const markers = (asset.markers ?? []).map(({ name }) => JSON.stringify(name)).join(' | ') || 'never';
  return [
    '// Generated by skac asset types.',
    'export interface Bindings {',
    '  readonly values: {',
    ...values,
    '  };',
    `  readonly markers: ${markers};`,
    '}',
    '',
  ].join('\n');
}

function packArtboard(asset) {
  const used = assetRuntime().usedAssetImages(asset.artboard.nodes);
  for (const fallback of Object.values(asset.imageSlots ?? {})) used.add(fallback);
  const images = used.size ? Object.fromEntries(Object.entries(asset.images).filter(([name]) => used.has(name))) : undefined;
  return { ...asset, images };
}

export function assetCommand(args, flags, cwd) {
  const [action, input, output] = args;
  if (!action) return { ok: true, commands: USAGE, schema: 'skac.asset/1', next: 'skac asset guide' };
  if (action === 'sample') return sample(input, output, cwd, flags.force);
  if (action === 'guide' && !output) {
    const guide = assetGuide(input);
    if (!guide) fail(`unknown asset guide "${input}"`, 'run skac asset guide to list topics');
    return guide;
  }
  if (action === 'image' && input && !output) return embedImage(resolve(cwd, input), flags.size);
  if (action === 'resource' && input && !output) return embedResource(resolve(cwd, input));
  if (!['check', 'trace', 'frame', 'pack', 'types', 'preview'].includes(action) || !input || output) {
    fail('invalid asset command', 'run skac asset for the command list');
  }
  const path = resolve(cwd, input);
  const { file, source } = readAsset(path, action === 'pack' || action === 'check');
  const isBundle = file.schema === 'skac.bundle/1';
  const asset = assetRuntime().selectArtboard(file, flags.artboard);
  const bundleInfo = isBundle ? {
    bundle: file.name, artboards: Object.keys(file.artboards), defaultArtboard: file.defaultArtboard,
    selectedArtboard: flags.artboard ?? file.defaultArtboard,
  } : {};
  if (action === 'check') {
    const runtime = assetRuntime();
    const { warnings } = runtime.validateMachine(asset.machine, { clips: asset.clips });
    const summary = { ok: true, file: path, ...describe(asset), ...bundleInfo, warnings: [...warnings, ...runtime.sparseBlendWarnings(asset)] };
    if (!asset.attachments?.length) return summary;
    const rows = trace(asset, flags);
    const attachments = assetRuntime().measureAttachments(asset.attachments, rows);
    const violation = attachments.find((item) => item.distance > item.maxDistance);
    if (violation) {
      const { from, to, distance, maxDistance, t_ms: at } = violation;
      fail(`attachment ${from} → ${to} is ${distance} artboard points apart at ${at} ms (limit ${maxDistance})`,
        'render the reported time with asset frame to inspect the points and their transforms', { file: path, attachments });
    }
    return { ...summary, attachments, samples: rows.length };
  }
  if (action === 'trace') return { ok: true, name: asset.name, trace: trace(asset, flags) };
  const stem = input.replace(/(?:\.motion)?\.json$|\.skmotion$/i, '');
  if (action === 'preview') {
    const size = flags.size === undefined ? [asset.artboard.width, asset.artboard.height] : dimensions(flags.size);
    if (!size) fail('invalid preview size', 'use two dimensions from 1 to 4096, like --size=360x640');
    const suffix = flags.artboard && isBundle ? `.${flags.artboard}` : '';
    const destination = resolve(cwd, flags.out ?? `${stem}${suffix}.preview.html`);
    if (destination === path) fail('preview output is the same file', 'use a different --out path');
    writeOutput(destination, previewHTML(source, size, Boolean(flags.reduced), flags.artboard), flags.force);
    return { ok: true, file: destination, source: path, name: asset.name, renderer: 'svg', ...bundleInfo };
  }
  if (action === 'types') {
    const suffix = flags.artboard && isBundle ? `.${flags.artboard}` : '';
    const destination = resolve(cwd, flags.out ?? `${stem}${suffix}.bindings.d.ts`);
    if (destination === path) fail('source and destination are the same file', 'choose another path with --out');
    const declaration = bindingsDeclaration(asset);
    if (flags.check) {
      if (!existsSync(destination) || readFileSync(destination, 'utf8') !== declaration) {
        fail('asset bindings are missing or stale', 'run asset types with --force to regenerate', { file: destination });
      }
    } else writeOutput(destination, declaration, flags.force);
    return { ok: true, name: asset.name, file: destination, ...bundleInfo };
  }
  if (action === 'frame') {
    if (flags.trace && /[,:]/.test(flags.trace)) fail('asset frame takes one time', 'like --trace=250');
    let size;
    if (flags.size !== undefined) {
      const sides = dimensions(flags.size);
      if (!sides) fail('invalid frame size', 'use two dimensions from 1 to 4096, like --size=1200x240');
      size = { width: sides[0], height: sides[1] };
    }
    const [row] = trace(asset, flags);
    const destination = resolve(cwd, flags.out ?? `${stem}-${row.t_ms}.svg`);
    if (destination === path) fail('source and destination are the same file', 'choose another path with --out');
    const visual = extname(path).toLowerCase() === '.skmotion' ? asset : applyDefaultFont(asset);
    writeOutput(destination, assetRuntime().assetSVG(visual, row.channels, size, row.values), flags.force);
    return { ok: true, name: asset.name, file: destination, t_ms: row.t_ms, states: row.states };
  }
  const destination = resolve(cwd, flags.out ?? `${stem}.skmotion`);
  if (destination === path) fail('source and destination are the same file', 'choose another path with --out');
  const packedFile = applyDefaultFont(isBundle ? {
    ...file, artboards: Object.fromEntries(Object.entries(file.artboards).map(([name, artboard]) => [name, packArtboard(artboard)])),
  } : packArtboard(asset));
  const json = JSON.stringify(packedFile);
  const size = Buffer.byteLength(json);
  const limit = assetRuntime().MAX_ASSET_BYTES;
  if (size > limit) fail('packed asset exceeds 1 MiB', 'reduce embedded resources and pack again');
  assetRuntime().parseAssetFile(json);
  const packed = size < limit ? `${json}\n` : json;
  writeOutput(destination, packed, flags.force);
  return { ok: true, file: destination, bytes: Buffer.byteLength(packed), ...describe(asset), ...bundleInfo,
    next: 'skac asset preview <file.skmotion>',
  };
}
