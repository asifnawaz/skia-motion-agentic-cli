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

async function loadCanvasKit() {
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
 * Where each sampled text's lines sit inside its node, from Skia's paragraph layout with the asset's fonts (host font slots included).
 * A text that cannot be laid out (a platform font, a missing slot or missing glyphs) is left out, and the caller uses its declared box.
 * @returns {Promise<Map<string, {left: number, top: number, width: number, height: number, source: 'layout'}>>} keyed by `extentKey`.
 */
export async function measureTextExtents({ fonts, missing }, cases) {
  const extents = new Map();
  let kit;
  let provider;
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
        }
      }
      const { lines, missing: unresolved } = paragraphMetrics(kit, provider, node, text.replaceAll('\r\n', '\n'), false);
      const shown = lines.slice(0, node.maxLines ?? 1);
      if (unresolved.length || !shown.length) continue;
      const left = Math.min(...shown.map((line) => line.left));
      const right = Math.max(...shown.map((line) => line.left + line.width));
      const height = shown.reduce((sum, line) => sum + line.height, 0);
      extents.set(key, { left, top: 0, width: Math.max(0, right - left), height, source: 'layout' });
    }
    return extents;
  } finally {
    provider?.delete();
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
