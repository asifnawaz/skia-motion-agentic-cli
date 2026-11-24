import { assetRuntime } from './asset-runtime.js';
import { fail } from './util.js';

const MAX_CASES = 4096;
let canvasKit;

function paragraphMetrics(kit, provider, node, text, capped) {
  const style = new kit.ParagraphStyle({
    textStyle: new kit.TextStyle({
      fontSize: node.fontSize,
      fontFamilies: node.fonts,
      fontFeatures: node.fontFeatures,
    }),
    textDirection: node.direction === 'rtl' ? kit.TextDirection.RTL : kit.TextDirection.LTR,
    textAlign: node.align === 'center' ? kit.TextAlign.Center : node.align === 'end' ? kit.TextAlign.End : kit.TextAlign.Start,
    ...(capped ? { maxLines: node.maxLines ?? 1, ellipsis: '…' } : {}),
  });
  const builder = kit.ParagraphBuilder.MakeFromFontProvider(style, provider);
  let paragraph;
  try {
    builder.addText(text);
    paragraph = builder.build();
    paragraph.layout(node.width);
    return capped ? { overflow: paragraph.didExceedMaxLines() } : {
      lines: paragraph.getLineMetrics(),
      missing: paragraph.unresolvedCodepoints(),
    };
  } finally {
    paragraph?.delete();
    builder.delete();
  }
}

export async function loadCanvasKit() {
  try {
    canvasKit ??= import('canvaskit-wasm').then(({ default: initialize }) => initialize());
    return await canvasKit;
  } catch (error) {
    canvasKit = undefined;
    fail(`could not start the text layout engine: ${error.message}`, 'reinstall the CLI with its CanvasKit dependency');
  }
}

function trackTextLayout(kit, provider, node, text) {
  if (!node.fonts?.length) return { reason: 'system-font' };
  // CanvasKit can report the CRLF pair as missing glyphs. Shape it as one hard break.
  const normalized = text.replaceAll('\r\n', '\n');
  const { lines, missing } = paragraphMetrics(kit, provider, node, normalized, false);
  if (missing.length) {
    const codepoints = [...new Set(missing)].sort((a, b) => a - b)
      .map((codepoint) => `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`);
    return { reason: 'missing-glyphs', codepoints };
  }
  return {
    ...paragraphMetrics(kit, provider, node, normalized, true),
    requiredLines: lines.length,
    wrapped: lines.some((line, index) => index < lines.length - 1 && !line.isHardBreak),
    explicitBreaks: text.match(/\r\n|[\n\r\u0085\u2028\u2029]/gu)?.length ?? 0,
  };
}

/**
 * Where each sampled text's ink sits inside its node, from Skia's paragraph layout with the asset's fonts (host font slots included):
 * the glyphs' own bounds, not the line box. `band` is the optical band from the font's metrics (runtime/asset-ink.ts textInk): the
 * x-height above the baseline plus the share of capitals and digits of the step to the cap height, or the ink itself for caseless scripts. A text that cannot be laid out (a platform font, a
 * missing slot or missing glyphs) is left out, and the caller uses its declared box.
 * @returns {Promise<Map<string, {left: number, top: number, width: number, height: number, band: [number, number], source: 'layout'}>>}
 *   keyed by `extentKey`.
 */
export async function measureTextExtents({ fonts, missing }, cases) {
  const extents = new Map();
  const fallbacks = new Map();
  let kit;
  let provider;
  const faces = new Map();
  const metrics = new Map();
  const heights = (typeface, size) => {
    if (!metrics.has(typeface)) metrics.set(typeface, new Map());
    const sizes = metrics.get(typeface);
    if (!sizes.has(size)) {
      const font = new kit.Font(typeface, size);
      try {
        const bounds = font.getGlyphBounds(font.getGlyphIDs('Hx'));
        sizes.set(size, { cap: Math.max(0, -bounds[1]), x: Math.max(0, -bounds[5]) });
      } finally {
        font.delete();
      }
    }
    return sizes.get(size);
  };
  try {
    for (const { node, text } of cases) {
      const key = extentKey(node, text);
      if (extents.has(key) || !node.fonts?.length || node.fonts.some((name) => missing.includes(name))) continue;
      if (!provider) {
        kit = await loadCanvasKit();
        provider = kit.TypefaceFontProvider.Make();
        for (const [name, uri] of Object.entries(fonts)) {
          const data = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
          if (provider.registerFont(data, name) === null) fail(`fonts.${name}: Skia could not decode the font`, 'replace it with a valid TTF or OTF');
          faces.set(name, kit.Typeface.MakeTypefaceFromData(data));
        }
      }
      const extent = inkOf(kit, provider, heights, node, text.replaceAll('\r\n', '\n'));
      // A glyph the fonts lack: the caller falls back to the declared box, and `fallbacks` says which text and which characters.
      if (extent?.unresolved) fallbacks.set(key, extent.unresolved);
      else if (extent) extents.set(key, extent);
    }
    extents.fallbacks = fallbacks;
    return extents;
  } finally {
    for (const face of faces.values()) face?.delete();
    provider?.delete();
  }
}

/** One text's ink box and optical band, in the node's own units, or undefined when a glyph is missing. */
function inkOf(kit, provider, heights, node, text) {
  const style = new kit.ParagraphStyle({
    textStyle: new kit.TextStyle({ fontSize: node.fontSize, fontFamilies: node.fonts, fontFeatures: node.fontFeatures }),
    textDirection: node.direction === 'rtl' ? kit.TextDirection.RTL : kit.TextDirection.LTR,
    textAlign: node.align === 'center' ? kit.TextAlign.Center : node.align === 'end' ? kit.TextAlign.End : kit.TextAlign.Start,
    maxLines: node.maxLines ?? 1,
  });
  const builder = kit.ParagraphBuilder.MakeFromFontProvider(style, provider);
  let paragraph;
  try {
    builder.addText(text);
    paragraph = builder.build();
    paragraph.layout(node.width);
    const unresolved = paragraph.unresolvedCodepoints();
    if (unresolved.length) return { unresolved: [...unresolved] };
    // Every glyph's box at its place, and the first run's face for the band: the rule runtime/asset-ink.ts gives the app too.
    const glyphs = [];
    let first;
    let last;
    let face;
    for (const line of paragraph.getShapedLines()) {
      first ??= line.baseline;
      last = line.baseline;
      for (const run of line.runs) {
        if (!run.typeface) continue;
        const font = new kit.Font(run.typeface, run.size);
        try {
          face ??= heights(run.typeface, run.size);
          const bounds = font.getGlyphBounds(run.glyphs);
          for (let i = 0; i < run.glyphs.length; i++) {
            const [l, t, r, b] = bounds.slice(i * 4, i * 4 + 4);
            const x = run.positions[i * 2];
            const y = run.positions[i * 2 + 1];
            glyphs.push([x + l, y + t, x + r, y + b]);
          }
        } finally {
          font.delete();
        }
      }
    }
    const measured = assetRuntime().textInk(glyphs, first, last, text, face ?? { cap: 0, x: 0 });
    if (!measured) return undefined;
    const { box: ink, band } = measured;
    return { left: ink[0], top: ink[1], width: ink[2] - ink[0], height: ink[3] - ink[1], band, source: 'layout' };
  } finally {
    paragraph?.delete();
    builder.delete();
  }
}

export const extentKey = (node, text) =>
  JSON.stringify([text, node.fonts, node.width, node.fontSize, node.maxLines, node.direction, node.align, node.fontFeatures]);

export async function measureTextLayout({ fonts, missing }, cases, viewport, samples) {
  const stats = { engine: 'skia-paragraph', viewport, samples, measured: 0, unmeasured: 0, overflow: 0 };
  const warnings = [];
  const cache = new Map();
  let kit;
  let provider;
  try {
    for (const { node, text, where, t_ms } of cases) {
      if (stats.measured + stats.unmeasured >= MAX_CASES) {
        fail('text layout check exceeds 4,096 distinct node and text pairs', 'check fewer trace times or choose one artboard');
      }
      const key = JSON.stringify([text, node.fonts, node.width, node.fontSize, node.maxLines, node.direction, node.align, node.fontFeatures]);
      let layout = cache.get(key);
      if (!layout) {
        const missingSlots = node.fonts?.filter((name) => missing.includes(name));
        if (missingSlots?.length) {
          layout = { reason: 'missing-font-slots', slots: missingSlots };
        } else if (node.fonts?.length && !provider) {
          kit = await loadCanvasKit();
          provider = kit.TypefaceFontProvider.Make();
          for (const [name, uri] of Object.entries(fonts)) {
            const data = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
            if (provider.registerFont(data, name) === null) {
              fail(`fonts.${name}: Skia could not decode the font`, 'replace it with a valid TTF or OTF');
            }
          }
        }
        layout ??= trackTextLayout(kit, provider, node, text);
        cache.set(key, layout);
      }
      const maxLines = node.maxLines ?? 1;
      const sample = { where, text, t_ms, viewport, width: node.width, fontSize: node.fontSize, maxLines };
      if (layout.reason) {
        stats.unmeasured++;
        warnings.push({
          code: 'text-layout-unavailable', ...sample, ...layout,
          error: layout.reason === 'missing-font-slots' ? `Provide font slots ${layout.slots.join(', ')} to measure this text.`
            : layout.reason === 'system-font' ? 'This node uses a platform font.' : 'The selected fonts do not cover all glyphs in this sample.',
          hint: layout.reason === 'missing-font-slots' ? 'Supply --font=slot=path/to/font.ttf for each required slot.'
            : 'Use fonts that cover the full label and rerun the check.',
        });
      } else {
        stats.measured++;
        if (!layout.overflow) continue;
        stats.overflow++;
        warnings.push({
          code: 'text-overflow', ...sample,
          requiredLines: layout.requiredLines, explicitBreaks: layout.explicitBreaks, wrapped: layout.wrapped,
          error: `The text needs ${layout.requiredLines} lines and exceeds the ${maxLines}-line budget.`,
          hint: 'Widen the text node, increase maxLines, or shorten the sampled label.',
        });
      }
    }
    return { stats, warnings };
  } finally {
    provider?.delete();
  }
}

/**
 * The drawn part of each image, from its alpha: left, top, right and bottom as fractions of the image (alpha above 10 of 255).
 * A clear margin in a sprite is not ink, so a coin with padding is judged by the coin. Slots resolve to their fallback image.
 * @returns {Promise<Map<string, [number, number, number, number]>>}
 */
export async function measureImageInk(images = {}, slots = {}) {
  const ink = new Map();
  const names = [...Object.keys(images), ...Object.keys(slots)];
  if (!names.length) return ink;
  const kit = await loadCanvasKit();
  for (const name of names) {
    const uri = images[name] ?? images[slots[name]];
    if (typeof uri !== 'string' || !uri.startsWith('data:')) continue;
    const image = kit.MakeImageFromEncoded(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'));
    if (!image) continue;
    try {
      const width = image.width();
      const height = image.height();
      const pixels = image.readPixels(0, 0, {
        width, height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
      });
      if (!pixels) continue;
      let [x0, y0, x1, y1] = [width, height, -1, -1];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3] <= 10) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 >= 0) ink.set(name, [x0 / width, y0 / height, (x1 + 1) / width, (y1 + 1) / height]);
    } finally {
      image.delete();
    }
  }
  return ink;
}
