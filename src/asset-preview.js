import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

let player;
let typeface;

/** Pack the viewer and its source together so the result can open offline. */
export function previewHTML(source, size, reduced, artboard) {
  player ??= buildSync({
    entryPoints: [fileURLToPath(new URL('./asset-preview.ts', import.meta.url))],
    bundle: true,
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;

  const fonts = new URL('../templates/fonts/allo-1.0.3/', import.meta.url);
  typeface ??= {
    data: readFileSync(new URL('Allo-Regular.woff2', fonts)).toString('base64'),
    license: readFileSync(new URL('OFL.txt', fonts), 'utf8'),
  };
  const template = readFileSync(new URL('./asset-preview.html', import.meta.url), 'utf8')
    .replace('/* skac-ui-font */', `@font-face { font-family: "Allo"; src: url("data:font/woff2;base64,${typeface.data}") format("woff2"); font-style: normal; font-weight: 400 }`);
  const binary = typeof source !== 'string';
  const data = JSON.stringify({
    source: binary ? source.toString('base64') : source, size, reduced, artboard, ...(binary && { binary }),
  }).replaceAll('<', '\\u003c');
  const license = JSON.stringify(typeface.license).replaceAll('<', '\\u003c');
  return `${template}<script id="font-license" type="application/json">${license}</script>
<script id="scene" type="application/json">${data}</script>
<script>${player}</script>
</body>
</html>
`;
}
