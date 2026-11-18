// A toy stand-in for onetake, so the e2e tests create projects without the network (see test/e2e/offline-libs.js).
(function (root) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const OM = { version: 'offline-fixture', clamp };
  root.OM = OM;
})(typeof window !== 'undefined' ? window : globalThis);
