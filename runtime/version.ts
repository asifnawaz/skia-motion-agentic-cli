import packageJson from '../package.json';

export const runtimeVersion = packageJson.version;

function compareVersions(a: string, b: string): number {
  const [aCore = '', ...aPre] = a.split('+')[0]!.split('-');
  const [bCore = '', ...bPre] = b.split('+')[0]!.split('-');
  const left = aCore.split('.').map(Number);
  const right = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = left[i]! - right[i]!;
    if (diff) return diff;
  }
  if (!aPre.length || !bPre.length) return Number(!aPre.length) - Number(!bPre.length);
  const x = aPre.join('-').split('.');
  const y = bPre.join('-').split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const l = x[i]!;
    const r = y[i]!;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return Number(l) - Number(r);
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return x.length - y.length;
}

export function assertRuntimeVersion(exportedBy: string): void {
  if (compareVersions(runtimeVersion, exportedBy) < 0) {
    const install = packageJson.name === 'skia-motion-runtime'
      ? `Install the app runtime for ${exportedBy} or newer from ${packageJson.homepage}/releases.`
      : `Install ${packageJson.name}@${exportedBy} or newer.`;
    throw new Error(`This machine was exported by Skia Motion ${exportedBy}, but the installed runtime is ${runtimeVersion}. ${install}`);
  }
}
