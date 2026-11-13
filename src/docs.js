import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, levenshteinNear, readText } from './util.js';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_DOCS = join(PACKAGE_ROOT, 'docs');

const nl = (text) => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);
const heading = (text) => (/^#\s+(.+)$/m.exec(text) || [])[1] || '';
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Path shown to agents: relative to cwd when inside it, else absolute. */
export const shown = (p) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? `./${r}` : p;
};

const walk = (dir, base = dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else if (e.endsWith('.md')) out.push({ name: relative(base, p).replace(/\.md$/, '').split('\\').join('/'), path: p });
  }
  return out;
};

/** All topics: the package docs (README is the index, not a topic), then each configured docs dir. */
export const listTopics = (cfg) => {
  const seen = new Set();
  const topics = [];
  for (const dir of [PACKAGE_DOCS, ...cfg.docs]) {
    for (const t of walk(dir)) {
      if (dir === PACKAGE_DOCS && t.name === 'README') continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      const text = readText(t.path);
      topics.push({ name: t.name, path: shown(t.path), lines: nl(text), heading: heading(text), _abs: t.path });
    }
  }
  return topics;
};

const LONG_TOPIC = 250;

/** `##` and `###` headings (outside code fences) with the line range each section covers. */
const sectionsOf = (lines) => {
  const heads = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) heads.push({ heading: m[2], level: m[1].length, start: i });
  });
  return heads.map((h) => {
    const next = heads.find((x) => x.start > h.start && x.level <= h.level);
    return { ...h, end: next ? next.start : lines.length };
  });
};

const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

/** The one section a name picks: exact heading first, then the one heading holding all its words. */
const pickSection = (sections, name) => {
  const q = name.trim().toLowerCase();
  const exact = sections.filter((s) => s.heading.toLowerCase() === q);
  const found = exact.length ? exact : sections.filter((s) => words(q).every((w) => s.heading.toLowerCase().includes(w)));
  return found.length === 1 ? found[0] : { found };
};

/** Headings that hold a word close to one of the query's words (a typo, a part of a name). */
const closeHeadings = (name, sections) => {
  const vocab = [...new Set(sections.flatMap((s) => words(s.heading)))];
  const close = new Set(words(name).flatMap((w) => levenshteinNear(w, vocab, 3)));
  return sections.filter((s) => words(s.heading).some((w) => close.has(w))).slice(0, 5).map((s) => s.heading);
};

const logRead = (cfg, entry) => {
  mkdirSync(cfg.out, { recursive: true });
  appendFileSync(join(cfg.out, 'docs-reads.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
};

/**
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {{topic?: string, section?: string, search?: string, as?: string}} opts
 */
export const docsCommand = (cfg, { topic, section, search, as = 'agent' }) => {
  const topics = listTopics(cfg);
  const indexPath = join(PACKAGE_DOCS, 'README.md');
  if (search) {
    const q = search.toLowerCase();
    const hits = [];
    const sources = topics.map((t) => ({ topic: t.name, abs: t._abs }));
    if (existsSync(indexPath)) sources.unshift({ topic: 'README', abs: indexPath });
    for (const s of sources) {
      readText(s.abs).split('\n').forEach((line, i) => {
        if (line.toLowerCase().includes(q)) hits.push({ topic: s.topic, line: i + 1, text: clip(line.trim()) });
      });
    }
    return { ok: true, query: search, hits };
  }
  if (!topic) {
    const clean = topics.map(({ _abs, ...t }) => t);
    if (!existsSync(indexPath)) {
      return { ok: true, index: null, note: 'docs/README.md is missing from this package', topics: clean };
    }
    const text = readText(indexPath);
    logRead(cfg, { topic: 'index', path: shown(indexPath), lines: nl(text), as });
    return { ok: true, index: { path: shown(indexPath), lines: nl(text), text }, topics: clean };
  }
  const t = topics.find((x) => x.name === topic);
  if (!t) {
    const near = levenshteinNear(topic, topics.map((x) => x.name));
    fail(`no docs topic ${JSON.stringify(topic)}`, `topics: ${topics.map((x) => x.name).join(', ')}`, near.length ? { did_you_mean: near } : {});
  }
  const text = readText(t._abs);
  const lines = text.replace(/\n$/, '').split('\n');
  if (section || t.lines > LONG_TOPIC) {
    const sections = sectionsOf(lines);
    const read = (h) => `skac docs ${t.name} ${JSON.stringify(h)}`;
    if (!section) {
      logRead(cfg, { topic: t.name, path: t.path, lines: t.lines, as });
      return {
        ok: true, topic: t.name, path: t.path, lines: t.lines,
        notice: `This topic has ${t.lines} lines, so only its sections are listed. Read one with: skac docs ${t.name} "<heading>"`,
        sections: sections.map((s) => ({ heading: s.heading, lines: s.end - s.start, read: read(s.heading) })),
      };
    }
    const hit = pickSection(sections, section);
    if (!hit.heading) {
      const pool = hit.found.length ? hit.found : sections;
      const near = hit.found.length ? pool.map((s) => s.heading) : closeHeadings(section, sections);
      const list = (near.length ? near : sections.slice(0, 5).map((s) => s.heading)).map((h) => read(h)).join(' | ');
      fail(`${hit.found.length ? 'several sections match' : 'no section'} ${JSON.stringify(section)} in docs topic ${t.name}`, `closest: ${list}`);
    }
    logRead(cfg, { topic: t.name, section: hit.heading, path: t.path, lines: hit.end - hit.start, as });
    return { ok: true, topic: t.name, path: t.path, section: hit.heading, lines: hit.end - hit.start, from: hit.start + 1, text: lines.slice(hit.start, hit.end).join('\n') + '\n' };
  }
  logRead(cfg, { topic: t.name, path: t.path, lines: t.lines, as });
  return { ok: true, topic: t.name, path: t.path, lines: t.lines, text };
};
