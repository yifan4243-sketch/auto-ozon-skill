export function parseMtopJsonp<T = unknown>(text: string): T {
  const trimmed = text.trim();
  const match = trimmed.match(/^mtopjsonp\w+\(([\s\S]*)\)$/);
  return JSON.parse(match ? match[1]! : trimmed) as T;
}

export const parseMtop = parseMtopJsonp;
