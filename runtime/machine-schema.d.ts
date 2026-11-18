type Finding = { where: string; error: string; hint: string };

export function validateMachine(
  machine: unknown,
  options?: { clips?: Record<string, { ms: number }>; clipNames?: string[] },
): { problems: Finding[]; warnings: Finding[] };
