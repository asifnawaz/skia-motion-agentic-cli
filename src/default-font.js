import { readFileSync } from 'node:fs';

const directory = new URL('../templates/fonts/allo-1.0.3/', import.meta.url);
let allo;

function fontResource() {
  allo ??= {
    uri: `data:font/otf;base64,${readFileSync(new URL('Allo-Regular.otf', directory)).toString('base64')}`,
    license: readFileSync(new URL('OFL.txt', directory), 'utf8'),
  };
  return allo;
}

function needsFont(nodes) {
  return nodes.some((node) => {
    if (node.kind === 'text') return node.fonts === undefined;
    if (node.kind === 'group') return needsFont(node.children);
    if (node.kind === 'mesh') return Object.values(node.pins ?? {}).some(({ children }) => children && needsFont(children));
    return false;
  });
}

function assignFont(nodes, name) {
  return nodes.map((node) => {
    if (node.kind === 'text' && node.fonts === undefined) return { ...node, fonts: [name] };
    if (node.kind === 'group') return { ...node, children: assignFont(node.children, name) };
    if (node.kind === 'mesh' && node.pins) return {
      ...node, pins: Object.fromEntries(Object.entries(node.pins).map(([key, pin]) => [
        key, pin.children ? { ...pin, children: assignFont(pin.children, name) } : pin,
      ])),
    };
    return node;
  });
}

export function applyDefaultFont(file) {
  const bundle = file.schema === 'skac.bundle/1';
  const boards = bundle ? Object.values(file.artboards) : [file];
  if (!boards.some(({ artboard }) => needsFont(artboard.nodes))) return file;

  const { uri, license } = fontResource();
  const reserved = new Set([file, ...boards].flatMap(({ fonts, fontSlots }) =>
    [...Object.keys(fonts ?? {}), ...Object.keys(fontSlots ?? {})].map((name) => name.toLowerCase())));
  let name = 'SkacAllo';
  for (let suffix = 2; reserved.has(name.toLowerCase()); suffix++) name = `SkacAllo${suffix}`;
  const withFont = (board) => ({
    ...board, artboard: { ...board.artboard, nodes: assignFont(board.artboard.nodes, name) },
  });
  const resources = {
    fonts: { ...file.fonts, [name]: uri },
    fontLicenses: { ...file.fontLicenses, [name]: license },
  };
  return bundle ? {
    ...file, ...resources,
    artboards: Object.fromEntries(Object.entries(file.artboards).map(([key, board]) => [key, withFont(board)])),
  } : { ...withFont(file), ...resources };
}
