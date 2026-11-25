type Finding = { where: string; error: string; hint: string };

export function validateMachine(
  machine: unknown,
  options?: { clips?: Record<string, { ms: number }>; clipNames?: string[]; lenient?: boolean },
): { problems: Finding[]; warnings: Finding[] };
