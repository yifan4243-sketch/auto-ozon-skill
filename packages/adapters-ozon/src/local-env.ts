import fs from 'node:fs';
import path from 'node:path';

const LOCAL_OZON_KEYS = [
  'OZON_CLIENT_ID',
  'OZON_API_KEY',
  'OZON_PERFORMANCE_CLIENT_ID',
  'OZON_PERFORMANCE_CLIENT_SECRET',
] as const;

export function loadOzonEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): Record<string, string> {
  const merged = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const root = findWorkspaceRoot(startDirectory);
  if (!root) return merged;
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return merged;
  const local = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const key of LOCAL_OZON_KEYS) {
    if (!merged[key] && local[key]) merged[key] = local[key];
  }
  return merged;
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function findWorkspaceRoot(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
