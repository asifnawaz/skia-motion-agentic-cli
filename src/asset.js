import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, constants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parseCommands } from './args.js';
import { assetGuide } from './asset-guide.js';
import { previewHTML } from './asset-preview.js';
import { extentKey, measureImageInk, measureTextExtents, measureTextLayout } from './asset-text-layout.js';
import { platesOf, textInPlate } from './asset-plate.js';
import { causalChain } from './asset-chain.js';
import { measureAssetFrames, renderAssetPNG } from './asset-canvaskit.js';
import { aimLandings, hasAims } from './asset-land.js';
import { measureLandings, splitAuthoring, textClearance } from './asset-clear.js';
import { loadConfig } from './config.js';
import { applyDefaultFont } from './default-font.js';
import { PACKAGE_ROOT } from './docs.js';
import { assetRuntime } from './asset-runtime.js';
import { CliError, fail } from './util.js';

const SAMPLES = {
  'game-hud': 'Health and ammo bindings, low-health feedback, and a reload cue',
  'reward-counter': 'A real-text XP label with a landing pulse and reduced-motion rest pose',
  sprout: 'Mascot reactions with a host-controlled highlight',
  'versus-hud': 'Two fighter health and super meters, a round timer, and feathered hit flashes',
};

const USAGE = [
  'skac asset guide [workflow|format|binary|text|font-slots|hud|character|lighting|feathering|images|mesh|masking|attachments|layout|playback|migrate]',
  'skac asset sample [game-hud|reward-counter|sprout|versus-hud] [output.json]',
  'skac asset image <file.png|file.webp> [--size=<maxWidth>x<maxHeight>]',
  'skac asset resource <font.ttf|font.otf|cue.wav|cue.mp3|cue.m4a|cue.aac>',
  'skac asset check <file> [--strict] [--text-layout] [--font=slot=font.ttf] [--size=360x640] [--trace=0:2400:16] [--commands=cue@0] (also runs landings, skac/text-clear, skac/text-in-plate and skac/causal-chain)',
  'skac asset trace <file> --trace=0,250,800 --commands "health=0.2@0.1 reload@0.25"',
  'skac asset cost <file> [--trace=0:3000:16] [--commands=cue@0] [--size=360x640] [--font=slot=font.ttf] (frame time and Skia objects per frame, drawn by the app\'s own draw code)',
  'skac asset frame <file> --trace=250 [--font=slot=font.ttf] [--size=1200x240] [--out=<frame.svg|frame.png>] [--background=#FFFFFF]',
  'skac asset preview <file.skmotion> [--artboard=<name>] [--font=slot=font.ttf] [--size=1200x240] [--out=<preview.html>] [--force]',
  'skac asset types <file> [--artboard=<name>] [--out=<bindings.d.ts>] [--force|--check]',
  'skac asset pack <file> [--format=json|binary] [--fonts=host] [--out=<name.skmotion>] [--force]',
  'skac asset unpack <file.skmotion> [--out=<source.motion.json>] [--force]',
];

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
    ...(asset.fontSlots && { fontSlots: asset.fontSlots }),
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
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail(`cannot read ${path}`, 'pass a JSON source or a .skmotion file');
  }
  try {
    const runtime = assetRuntime();
    if (runtime.isBinaryAsset(bytes)) return { file: runtime.parseAssetFile(bytes), source: bytes, binary: true, boards: new Map() };
    const packed = extname(path).toLowerCase() === '.skmotion';
    // Node ids, landings and allowOverlap are authoring-only: asset check reads them and the runtime never sees them.
    const { text: source, boards } = packed ? { text: bytes.toString('utf8'), boards: new Map() } : splitAuthoring(bytes.toString('utf8'));
    const file = authoring && !packed ? runtime.parseAssetSource(source) : runtime.parseAssetFile(source);
    return { file, source, boards, aims: hasAims(boards), authoring: authoring && !packed };
  } catch (error) {
    fail(error.message, 'see skac asset sample for an example of skac.asset/1', { file: path });
  }
}

/**
 * Write the end keys of landings marked aim: true, measuring ink as asset check does (text laid out with the asset's fonts and host slots,
 * images by alpha), so every command (check, trace, frame, pack) sees the aimed flight.
 */
async function aimSource(read, path, flags, cwd) {
  const runtime = assetRuntime();
  const asset = runtime.selectArtboard(read.file);
  const visual = applyDefaultFont(asset);
  const values = Object.fromEntries(Object.entries(asset.machine.values ?? {}).map(([name, value]) => [name, value.default]));
  const fonts = runtime.resolveAssetFonts(visual, readFontOverrides(asset, flags.font, cwd));
  const [extents, ink] = await Promise.all([
    measureTextExtents(fonts, runtime.assetTextSamples(visual, [{ t_ms: 0, values, channels: asset.channels }])),
    measureImageInk(visual.images, visual.imageSlots),
  ]);
  try {
    const { text, aimed } = aimLandings(runtime, read.source, read.boards, {
      visual: applyDefaultFont, missing: fonts.missing,
      textExtent: (node, _where, text) => extents.get(extentKey(runtime.rollTextStyle(node), text)) ?? runtime.declaredText(node),
      imageInk: (image) => ink.get(image),
    });
    const file = read.authoring ? runtime.parseAssetSource(text) : runtime.parseAssetFile(text);
    return { ...read, file, source: text, aimed };
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(error.message, 'see skac asset guide landings', { file: path });
  }
}

function jsonAssetSize(file, indent = 0) {
  const sizeBreakdown = { scene: 0, images: 0, fonts: 0, audio: 0 };
  const metadata = assetRuntime().mapFileResources(file, (uri, kind) => {
    sizeBreakdown[kind] += uri.length;
    return '';
  });
  sizeBreakdown.scene = Buffer.byteLength(JSON.stringify(metadata, null, indent));
  const bytes = Object.values(sizeBreakdown).reduce((sum, value) => sum + value, 0);
  return { bytes, sizeBreakdown };
}

function embedResource(path, limit = Math.floor(assetRuntime().MAX_ASSET_BYTES * 0.75) - 32) {
  const types = {
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  };
  const type = types[extname(path).toLowerCase()];
  if (!type) fail('unsupported resource type', 'use a TTF or OTF font, or a WAV, MP3, M4A or AAC sound');
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

function readFontOverrides(asset, entries = [], cwd) {
  if (!entries.length) return {};
  const overrides = new Map();
  const files = new Map();
  let total = 0;
  const limit = 16 * 1024 * 1024;
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    if (separator < 1 || !entry.slice(separator + 1)) fail('invalid --font mapping', 'use --font=slot=path/to/font.ttf');
    if (!Object.hasOwn(asset.fontSlots ?? {}, name)) fail(`unknown font slot "${name}"`, 'run asset check to list the declared font slots');
    if (overrides.has(name)) fail(`duplicate --font mapping for "${name}"`, 'supply one local file per font slot');
    const path = resolve(cwd, entry.slice(separator + 1));
    if (!['.ttf', '.otf'].includes(extname(path).toLowerCase())) fail('expected a TTF or OTF font', 'pass --font=slot=path/to/font.ttf');
    let font = files.get(path);
    if (!font) {
      font = embedResource(path, limit - total);
      files.set(path, font);
      total += font.bytes;
    }
    overrides.set(name, font.uri);
  }
  return Object.fromEntries(overrides);
}

/**
 * The fonts a frame or preview draws with. A slot with no --font draws in the default face, as the app draws a slot the host does not
 * pass, and the result warns font-slot-fallback naming it.
 */
function previewFonts({ fonts, missing }) {
  const warnings = missing.length ? [{
    code: 'font-slot-fallback', slots: missing,
    error: `font slots ${missing.join(', ')} have no face here, so their text is drawn in the default face, as the app draws a slot the host does not pass`,
    hint: 'supply --font=slot=path/to/font.ttf for each slot to see its own face',
  }] : [];
  return { fonts, warnings };
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

function traceViewport(size) {
  if (size === undefined) return;
  const sides = dimensions(size);
  if (!sides) fail('invalid viewport size', 'use two dimensions from 1 to 4096, like --size=360x640');
  return { width: sides[0], height: sides[1] };
}

function trace(asset, flags, viewport = traceViewport(flags.size)) {
  const times = traceTimes(flags.trace ?? '0');
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

function removeEmbeddedFonts(file) {
  const { fonts, fontLicenses, fontSlots, ...rest } = file;
  return { ...rest, ...(fontSlots && { fontSlots: Object.fromEntries(Object.keys(fontSlots).map((name) => [name, {}])) }) };
}

function packHostFonts(file) {
  const runtime = assetRuntime();
  const bundle = file.schema === 'skac.bundle/1';
  for (const artboard of bundle ? Object.keys(file.artboards) : [undefined]) {
    const board = runtime.selectArtboard(file, artboard);
    for (const { node, where } of runtime.assetTextNodes(board.artboard.nodes)) {
      const embedded = node.fonts?.find((name) => !Object.hasOwn(board.fontSlots ?? {}, name));
      if (!node.fonts || embedded) {
        const field = artboard ? `artboards.${artboard}.${where}.fonts` : `${where}.fonts`;
        fail(`${field}: host export would remove the ${embedded ?? 'default'} font`,
          'reference a declared font slot, or use fonts: [] for the platform font', { where: field, ...(embedded && { font: embedded }) });
      }
    }
  }
  return bundle ? {
    ...removeEmbeddedFonts(file),
    artboards: Object.fromEntries(Object.entries(file.artboards).map(([name, board]) => [name, removeEmbeddedFonts(board)])),
  } : removeEmbeddedFonts(file);
}

/**
 * The placement rules' severities. A rule set in skia-motion.json ("rules": { "skac/text-clear": "error" }) has that severity. Otherwise
 * the two text rules warn, and are errors under --strict or an asset's "checks": "strict"; causal-chain, which runs only on an authored
 * chain, is an error.
 */
function placementSeverities(cwd, strict) {
  const { rules, configPath } = loadConfig(cwd);
  const text = strict ? 'error' : 'warn';
  const defaults = { 'skac/text-clear': text, 'skac/text-in-plate': text, 'skac/causal-chain': 'error' };
  return Object.fromEntries(Object.keys(defaults).map((id) => {
    const severity = rules[id] ?? defaults[id];
    if (!['error', 'warn', 'off'].includes(severity)) fail(`rules["${id}"] in ${configPath} is ${JSON.stringify(severity)}`, 'use error, warn or off');
    return [id, severity];
  }));
}

/**
 * The trace the placement checks read when no --trace is given: from 0 to 300 ms past the longest clip after the last command, at most
 * 500 samples, plus the exact time of every landing given in ms.
 */
function placementTimes(asset, flags, landings = []) {
  if (flags.trace) return flags.trace;
  const longest = Math.max(0, ...Object.values(asset.clips).map(({ ms }) => ms));
  const events = flags.commands ? parseCommands(flags.commands).events : [];
  const after = Math.max(0, ...events.map(({ at }) => at * 1000));
  const span = Math.min(60000, Math.ceil(after + longest + 300));
  const exact = landings.map(({ at }) => at).filter((at) => typeof at === 'number' && at <= 60000);
  const step = Math.max(16, Math.ceil(span / (499 - exact.length)));
  const times = new Set(exact);
  for (let t = 0; t < span; t += step) times.add(t);
  times.add(span);
  return [...times].sort((a, b) => a - b).join(',');
}

/** A rolling number warns once that it needs a runtime that knows `roll`, and once per pair of values it cannot roll (it cuts at 0.5). */
function rollWarnings(runtime, visual, rows) {
  const warnings = [];
  const rowsIn = (nodes, parent) => nodes.forEach((node, index) => {
    if (node.kind !== 'group') return;
    const where = `${parent}[${index}]`;
    if (node.row) {
      warnings.push({ code: 'row-runtime', where: `${where}.row`, error: 'a row needs a skia-motion-runtime release that knows row', hint: 'upgrade the app\'s runtime with this asset; older runtimes reject the file' });
      warnings.push({ code: 'row-approx', where: `${where}.row`, error: 'on react-native-skia before 3.10.2, and on React Native Web, the app places a row by its text\'s advances and cap height (no SkParagraph.extendedVisit), so it can sit up to a few points from what check measures', hint: 'ship on react-native-skia 3.10.2 or later for the measured placement' });
    }
    rowsIn(node.children, `${where}.children`);
  });
  rowsIn(visual.artboard.nodes, 'artboard.nodes');
  for (const { node, where } of runtime.assetTextNodes(visual.artboard.nodes)) {
    if (!node.roll) continue;
    warnings.push({ code: 'roll-runtime', where: `${where}.roll`, error: 'a rolling number needs a skia-motion-runtime release that knows roll (after 3.3.1)', hint: 'upgrade the app\'s runtime with this asset; older runtimes reject the file' });
    const seen = new Set();
    for (const { values } of rows) {
      const from = values[node.roll.from];
      const to = values[node.text.value];
      if (typeof from !== 'string' || typeof to !== 'string' || seen.has(`${from}|${to}`)) continue;
      seen.add(`${from}|${to}`);
      if (!runtime.rollFrame(from, to, 0.5)) {
        warnings.push({ code: 'roll-cut', where: `${where}.roll`, error: `"${from}" to "${to}" cannot roll: each must be one run of digits with the same prefix, suffix and digit system; it cuts at half way`, hint: 'drop inner separators ("1250", not "1,250") or roll only the digits and draw the rest as its own text' });
      }
    }
  }
  return warnings;
}

/**
 * Landings and skac/text-clear over one trace. Every node's drawn box comes from the same pose the player draws. Text takes its laid-out
 * ink from `extents` (laid out with the asset's fonts, host slots via --font) and otherwise the box it declares; `textBoxes` counts which.
 */
function placement(runtime, visual, rows, viewport, { extents, imageInk }, authored, severities, path, chained) {
  const severity = severities['skac/text-clear'];
  const sources = { layout: 0, declared: 0 };
  const seen = new Set();
  const fellBack = new Map();
  const extent = (node, where, text) => {
    const key = extentKey(runtime.rollTextStyle(node), text);
    const found = extents.get(key) ?? runtime.declaredText(node);
    if (!seen.has(`${where}|${text}`)) {
      seen.add(`${where}|${text}`);
      sources[found.source]++;
      const unresolved = extents.fallbacks?.get(key);
      if (unresolved && !fellBack.has(where)) fellBack.set(where, { text, unresolved });
    }
    return found;
  };
  const placed = rows.map((row) => ({
    t_ms: row.t_ms, states: row.states, markers: row.markers, channels: row.channels, entries: runtime.assetInkBoxes(visual, row.channels, row.values, extent, viewport, (image) => imageInk.get(image)),
  }));
  const ids = authored?.ids ?? new Map();
  const names = new Map([...ids].map(([id, where]) => [where, id]));
  const found = { samples: rows.length, warnings: rollWarnings(runtime, visual, rows) };
  for (const [where, { text, unresolved }] of fellBack) {
    const characters = unresolved.map((code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
    found.warnings.push({ code: 'text-layout-fallback', where, ...(names.has(where) && { id: names.get(where) }), text,
      error: `"${text}" has characters its fonts lack (${characters}), so check judges its declared box while the phone draws them in a fallback font`,
      hint: 'add a font with those characters to the text\'s fonts, or draw them as an image' });
  }
  const problems = [...chained.problems];
  if (authored?.landings.length) {
    found.landings = measureLandings(placed, authored.landings, ids, names, visual);
    for (const landing of found.landings) if (landing.problem) problems.push({ check: 'skac/landing', error: landing.problem, hint: landing.hint });
  }
  if (severity !== 'off') {
    const reacts = (found.landings ?? []).filter(({ t_ms }) => t_ms !== undefined).map(({ target, t_ms }) => ({ where: ids.get(target), from: t_ms }));
    const { isPlate, icons } = platesOf(visual, { ids, declared: new Map(authored?.plates ?? []) });
    const { errors, warnings } = textClearance(placed, { ids, names, severity, reacts, isPlate, icons, allow: [
      ...(authored?.allowOverlap ?? []),
      // A landing says its node belongs on its target.
      ...(authored?.landings ?? []).map(({ node, target }) => ({ nodes: [node, target], reason: 'the landing target' })),
    ] });
    found.textClear = { severity, textBoxes: sources, errors: errors.length, warnings: warnings.length };
    found.warnings.push(...warnings);
    for (const error of errors) problems.push({ check: 'skac/text-clear', ...error });
  }
  if (severities['skac/text-in-plate'] !== 'off') {
    const plates = new Map([...(authored?.plates ?? [])].map(([where, id]) => [where, id]));
    const { errors, warnings, unmeasured } = textInPlate(placed, { asset: visual, ids, names, declared: plates, severity: severities['skac/text-in-plate'] });
    found.textInPlate = { severity: severities['skac/text-in-plate'], errors: errors.length, warnings: warnings.length, unmeasured };
    found.warnings.push(...warnings);
    for (const error of errors) problems.push({ check: 'skac/text-in-plate', ...error });
  }
  if (problems.length) {
    const more = problems.length > 3 ? `; and ${problems.length - 3} more (see problems)` : '';
    fail(problems.slice(0, 3).map(({ error }) => error).join('; ') + more, problems[0].hint, { file: path, problems, ...found, ...(chained.summary && { chain: chained.summary }) });
  }
  return found;
}

export function assetCommand(args, flags, cwd) {
  const [action, input, output] = args;
  if (!action) return { ok: true, commands: USAGE, schema: 'skac.asset/1', next: 'skac asset guide' };
  if (flags['text-layout'] && action !== 'check') fail('--text-layout is for asset check', 'run skac asset check <file> --text-layout');
  if (flags.strict && action !== 'check') fail('--strict is for asset check', 'run skac asset check <file> --strict');
  if (flags.fonts !== undefined && action !== 'pack') {
    fail('--fonts=host is for asset pack', 'use it to omit embedded fonts from an asset that uses font slots');
  }
  if (flags.fonts !== undefined && flags.fonts !== 'host') fail('unknown font export option', 'use --fonts=host or omit --fonts to keep the authored fallbacks');
  if (flags.font?.length && !['preview', 'frame', 'cost', 'check', 'pack', 'trace'].includes(action)) {
    fail('--font is for asset preview, frame, check, pack or trace', 'supply --font=slot=path/to/font.ttf');
  }
  if (action === 'sample') return sample(input, output, cwd, flags.force);
  if (action === 'guide' && !output) {
    const guide = assetGuide(input);
    if (!guide) fail(`unknown asset guide "${input}"`, 'run skac asset guide to list topics');
    return guide;
  }
  if (action === 'image' && input && !output) return embedImage(resolve(cwd, input), flags.size);
  if (action === 'resource' && input && !output) return embedResource(resolve(cwd, input));
  if (!['check', 'trace', 'frame', 'cost', 'pack', 'unpack', 'types', 'preview'].includes(action) || !input || output) {
    fail('invalid asset command', 'run skac asset for the command list');
  }
  const path = resolve(cwd, input);
  const read = readAsset(path, action === 'pack' || action === 'check');
  return read.aims ? aimSource(read, path, flags, cwd).then((aimed) => assetAction(action, input, path, flags, cwd, aimed)) : assetAction(action, input, path, flags, cwd, read);
}

/** Run an asset command on a file already read (and its landings aimed). */
function assetAction(action, input, path, flags, cwd, { file, source, binary, boards, aimed }) {
  const stem = input.replace(/(?:\.motion)?\.json$|\.skmotion$/i, '');
  if (action === 'unpack') {
    const destination = resolve(cwd, flags.out ?? `${stem}.unpacked.motion.json`);
    if (destination === path) fail('unpack output is the same file', 'use a different --out path');
    const size = jsonAssetSize(file, 2);
    if (size.bytes >= assetRuntime().MAX_ASSET_SOURCE_BYTES) {
      fail('expanded JSON exceeds the output limit', 'keep the binary asset or reduce the repeated embedded resources', size);
    }
    const json = JSON.stringify(file, null, 2) + '\n';
    writeOutput(destination, json, flags.force);
    return { ok: true, file: destination, bytes: Buffer.byteLength(json), name: file.name };
  }
  const isBundle = file.schema === 'skac.bundle/1';
  const asset = assetRuntime().selectArtboard(file, flags.artboard);
  const hostFonts = readFontOverrides(asset, flags.font, cwd);
  const bundleInfo = isBundle ? {
    bundle: file.name, artboards: Object.keys(file.artboards), defaultArtboard: file.defaultArtboard,
    selectedArtboard: flags.artboard ?? file.defaultArtboard,
  } : {};
  if (action === 'check') {
    const runtime = assetRuntime();
    const { warnings } = runtime.validateMachine(asset.machine, { clips: asset.clips });
    const summary = {
      ok: true, file: path, ...describe(asset), ...bundleInfo, ...(aimed && { aimed }), warnings: [...warnings, ...runtime.sparseBlendWarnings(asset)],
    };
    const authored = boards.get(isBundle ? flags.artboard ?? file.defaultArtboard : '');
    const severities = placementSeverities(cwd, Boolean(flags.strict || authored?.strict));
    // The placement checks judge the authored source; a packed .skmotion has no ids, landings or allowances left to read.
    const authoring = !binary && extname(path).toLowerCase() !== '.skmotion';
    const textRules = severities['skac/text-clear'] !== 'off' || severities['skac/text-in-plate'] !== 'off';
    const clear = authoring && (Boolean(authored?.landings.length) || (textRules && runtime.assetTextNodes(asset.artboard.nodes).length > 0));
    // skac/causal-chain reads the clip's keys, not a trace; its findings join the placement checks' or fail on their own.
    const chained = { problems: [] };
    if (authoring && authored?.chain && severities['skac/causal-chain'] !== 'off') {
      const { errors, warnings: chainWarnings, report } = causalChain(asset, authored.chain, severities['skac/causal-chain']);
      summary.chain = { severity: severities['skac/causal-chain'], ...report, errors: errors.length, warnings: chainWarnings.length };
      summary.warnings.push(...chainWarnings);
      chained.problems = errors.map((error) => ({ check: 'skac/causal-chain', ...error }));
      chained.summary = summary.chain;
    }
    if (!clear && chained.problems.length) {
      const more = chained.problems.length > 3 ? `; and ${chained.problems.length - 3} more (see problems)` : '';
      fail(chained.problems.slice(0, 3).map(({ error }) => error).join('; ') + more, chained.problems[0].hint, { file: path, problems: chained.problems, chain: summary.chain });
    }
    if (!asset.attachments?.length && !flags['text-layout'] && !clear) return summary;
    const viewport = traceViewport(flags.size) ?? summary.artboard;
    if (clear) {
      const visual = applyDefaultFont(asset);
      const rows = trace(visual, { ...flags, trace: placementTimes(visual, flags, authored?.landings) }, viewport);
      // Text ink comes from Skia's layout with the asset's fonts (host slots via --font); an image's ink from its alpha.
      return Promise.all([
        measureTextExtents(runtime.resolveAssetFonts(visual, hostFonts), runtime.assetTextSamples(visual, rows)),
        measureImageInk(visual.images, visual.imageSlots),
      ]).then(([extents, imageInk]) => {
        const found = placement(runtime, visual, rows, viewport, { extents, imageInk }, authored, severities, path, chained);
        return checkRest({ ...summary, ...found, warnings: [...summary.warnings, ...found.warnings] });
      });
    }
    return checkRest(summary);
  }
  function checkRest(summary) {
    const runtime = assetRuntime();
    const viewport = traceViewport(flags.size) ?? summary.artboard;
    if (!asset.attachments?.length && !flags['text-layout']) return summary;
    const rows = trace(asset, flags, viewport);
    if (asset.attachments?.length) {
      const attachments = runtime.measureAttachments(asset.attachments, rows);
      const violation = attachments.find((item) => item.distance > item.maxDistance);
      if (violation) {
        const { from, to, distance, maxDistance, t_ms: at } = violation;
        fail(`attachment ${from} → ${to} is ${distance} artboard points apart at ${at} ms (limit ${maxDistance})`,
          'render the reported time with asset frame to inspect the points and their transforms', { file: path, attachments });
      }
      summary.attachments = attachments;
      summary.samples = rows.length;
    }
    if (!flags['text-layout']) return summary;
    const visual = binary || extname(path).toLowerCase() === '.skmotion' ? asset : applyDefaultFont(asset);
    const samples = new Set(rows.map(({ t_ms }) => t_ms)).size;
    return measureTextLayout(runtime.resolveAssetFonts(visual, hostFonts), runtime.assetTextSamples(visual, rows), viewport, samples)
      .then(({ stats, warnings: textWarnings }) => {
        // --text-layout names a text whose glyphs its fonts lack as text-layout-unavailable; the placement checks' fallback warning then
        // says the same of the same node, so it gives way.
        const named = new Set(textWarnings.filter(({ code }) => code === 'text-layout-unavailable').map(({ where }) => where));
        const own = summary.warnings.filter(({ code, where }) => code !== 'text-layout-fallback' || !named.has(where));
        return { ...summary, textLayout: stats, warnings: [...own, ...textWarnings] };
      });
  }
  if (action === 'trace') return { ok: true, name: asset.name, trace: trace(asset, flags) };
  if (action === 'preview') {
    const size = flags.size === undefined ? [asset.artboard.width, asset.artboard.height] : dimensions(flags.size);
    if (!size) fail('invalid preview size', 'use two dimensions from 1 to 4096, like --size=360x640');
    const suffix = flags.artboard && isBundle ? `.${flags.artboard}` : '';
    const destination = resolve(cwd, flags.out ?? `${stem}${suffix}.preview.html`);
    if (destination === path) fail('preview output is the same file', 'use a different --out path');
    const { warnings } = previewFonts(assetRuntime().resolveAssetFonts(asset, hostFonts));
    writeOutput(destination, previewHTML(source, size, Boolean(flags.reduced), flags.artboard, hostFonts), flags.force);
    return { ok: true, file: destination, source: path, name: asset.name, renderer: 'svg', ...bundleInfo, ...(warnings.length && { warnings }) };
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
  if (action === 'cost') {
    let size = { width: asset.artboard.width, height: asset.artboard.height };
    if (flags.size !== undefined) {
      const sides = dimensions(flags.size);
      if (!sides) fail('invalid frame size', 'use two dimensions from 1 to 4096, like --size=360x640');
      size = { width: sides[0], height: sides[1] };
    }
    const longest = Math.max(0, ...Object.values(asset.clips ?? {}).map((clip) => clip?.ms ?? 0));
    const rows = trace(asset, { ...flags, trace: flags.trace ?? `0:${Math.min(Math.max(longest, 1000), 7984)}:16` });
    const visual = binary || extname(path).toLowerCase() === '.skmotion' ? asset : applyDefaultFont(asset);
    const { fonts, warnings } = previewFonts(assetRuntime().resolveAssetFonts(visual, hostFonts));
    const drawn = { ...visual, fonts };
    return (visual.imageInk ? Promise.resolve(drawn) : addRowImageInk(drawn)).then((board) => measureAssetFrames(board, rows, size)).then((cost) => ({
      ok: true, name: asset.name, size, renderer: 'canvaskit-cpu', ...cost,
      note: 'Times are from the CPU rasteriser in Node: compare files and versions, not phones. Objects per frame are what the draw code allocates each frame on the UI thread.',
      ...(warnings.length && { warnings }),
    }));
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
    const png = Boolean(flags.out) && extname(flags.out).toLowerCase() === '.png';
    const destination = resolve(cwd, flags.out ?? `${stem}-${row.t_ms}.${png ? 'png' : 'svg'}`);
    if (destination === path) fail('source and destination are the same file', 'choose another path with --out');
    const visual = binary || extname(path).toLowerCase() === '.skmotion' ? asset : applyDefaultFont(asset);
    const { fonts, warnings } = previewFonts(assetRuntime().resolveAssetFonts(visual, hostFonts));
    if (png) {
      // The PNG comes from the app's own draw code over CanvasKit: blur, gradients and text as on the phone.
      const pixels = size ?? { width: asset.artboard.width, height: asset.artboard.height };
      const drawn = { ...visual, fonts };
      return (visual.imageInk ? Promise.resolve(drawn) : addRowImageInk(drawn)).then((board) => renderAssetPNG(board, row.channels, row.values, pixels, flags.background)).then((bytes) => {
        writeOutput(destination, bytes, flags.force);
        return { ok: true, name: asset.name, file: destination, t_ms: row.t_ms, states: row.states, renderer: 'canvaskit', ...(warnings.length && { warnings }) };
      });
    }
    writeOutput(destination, assetRuntime().assetSVG({ ...visual, fonts }, row.channels, size, row.values), flags.force);
    return { ok: true, name: asset.name, file: destination, t_ms: row.t_ms, states: row.states, ...(warnings.length && { warnings }) };
  }
  const destination = resolve(cwd, flags.out ?? `${stem}.skmotion`);
  if (destination === path) fail('source and destination are the same file', 'choose another path with --out');
  const format = flags.format ?? 'json';
  if (format !== 'json' && format !== 'binary') fail('unknown asset format', 'choose --format=json or --format=binary');
  const pruned = isBundle ? {
    ...file, artboards: Object.fromEntries(Object.entries(file.artboards).map(([name, artboard]) => [name, packArtboard(artboard)])),
  } : packArtboard(asset);
  const packedBoards = isBundle ? Object.values(pruned.artboards) : [pruned];
  if (packedBoards.some((board) => rowImages(board).size)) {
    return Promise.all(packedBoards.map(addRowImageInk)).then(() => writePack(pruned, { destination, format, flags, bundleInfo }));
  }
  return writePack(pruned, { destination, format, flags, bundleInfo });
}

/** A row places an embedded image by its alpha ink; the app cannot read pixels, so pack writes the ink for it (and a PNG frame of a source). */
async function addRowImageInk(board) {
  const names = rowImages(board);
  if (!names.size) return board;
  const ink = await measureImageInk(Object.fromEntries([...names].map((name) => [name, board.images[name]])));
  board.imageInk = Object.fromEntries([...ink].map(([name, box]) => [name, box.map((side) => Math.round(side * 10000) / 10000)]));
  return board;
}

/** Embedded images placed by a row (not host slots, which are placed by their box). */
function rowImages(board) {
  const names = new Set();
  const visit = (nodes) => nodes.forEach((node) => {
    if (node.kind === 'mesh') for (const pin of Object.values(node.pins ?? {})) if (pin.children) visit(pin.children);
    if (node.kind !== 'group') return;
    if (node.row) for (const child of node.children) if (child.kind === 'image' && !board.imageSlots?.[child.image]) names.add(child.image);
    visit(node.children);
  });
  visit(board.artboard.nodes);
  return names;
}

function writePack(pruned, { destination, format, flags, bundleInfo }) {
  const packedFile = flags.fonts === 'host' ? packHostFonts(pruned) : applyDefaultFont(pruned);
  const limit = assetRuntime().MAX_ASSET_BYTES;
  let packed;
  let sizeBreakdown;
  if (format === 'binary') {
    try {
      ({ data: packed, sizeBreakdown } = assetRuntime().encodeBinaryAsset(packedFile, (text) => Buffer.from(text, 'utf8'), limit));
      // Inspect with the same decoder as the preview and app.
      assetRuntime().parseAssetFile(packed);
    } catch (error) {
      const details = error.sizeBreakdown ? { bytes: error.bytes, sizeBreakdown: error.sizeBreakdown } : undefined;
      fail(error.message, 'check embedded resources and pack again', details);
    }
  } else {
    const size = jsonAssetSize(packedFile);
    if (size.bytes > limit) fail('packed asset exceeds 1 MiB', 'reduce embedded resources or pack with --format=binary', size);
    sizeBreakdown = size.sizeBreakdown;
    const json = JSON.stringify(packedFile);
    assetRuntime().parseAssetFile(json);
    packed = size.bytes < limit ? `${json}\n` : json;
    if (size.bytes < limit) sizeBreakdown.scene++;
  }
  writeOutput(destination, packed, flags.force);
  return { ok: true, file: destination, bytes: Buffer.byteLength(packed), sizeBreakdown, format,
    ...describe(assetRuntime().selectArtboard(packedFile, flags.artboard)), ...bundleInfo,
    next: 'skac asset preview <file.skmotion>',
  };
}
