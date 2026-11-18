// A stand-in for the built-in onetake entry: tests never touch the network, they serve this lib and its licence through an injected fetcher.
import { createHash } from 'node:crypto';
import { BUILTIN_LIBS } from '../../src/libs.js';

export const TOY_LIB = `// toy motion lib. Required Notice: Copyright (c) 2026 Toy Author
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const OM = { version: 'toy', clamp };
  root.OM = OM;
})(typeof window !== 'undefined' ? window : globalThis);
`;
export const TOY_LICENSE = 'Toy licence text.\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Point the built-in onetake entry at the toy files (its hashes) and return a fetcher that serves them and records each URL.
 * The entry is restored when the test process exits.
 */
export const installToyBuiltin = () => {
  process.env.SKAC_LIBS_FILE = '/dev/null'; // this machine's own libs file must not override the entry
  const entry = BUILTIN_LIBS.onetake;
  const saved = entry.files;
  entry.files = { 'lib/motion.js': sha(TOY_LIB), LICENSE: sha(TOY_LICENSE) };
  process.on('exit', () => { entry.files = saved; });
  const urls = [];
  const fetcher = (url) => {
    urls.push(url);
    return Buffer.from(url.endsWith('/lib/motion.js') ? TOY_LIB : TOY_LICENSE);
  };
  return { fetcher, urls };
};
