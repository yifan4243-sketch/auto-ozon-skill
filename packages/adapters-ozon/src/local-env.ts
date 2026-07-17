import fs from 'node:fs';
import path from 'node:path';

const LOCAL_OZON_KEYS = [
  'OZON_CLIENT_ID',
  'OZON_API_KEY',
  'OZON_PERFORMANCE_CLIENT_ID',
  'OZON_PERFORMANCE_CLIENT_SECRET',
] as const;

const SAFE_CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL',
] as const;

const OZON_CREDENTIAL_KEY = /^OZON_(?:CLIENT_ID|API_KEY)(?:_[A-Za-z0-9_]+)?$|^OZON_PERFORMANCE_(?:CLIENT_ID|CLIENT_SECRET)(?:_[A-Za-z0-9_]+)?$/u;

export function loadOzonEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
): Record<string, string> {
  const merged = selectOzonCredentials(env);
  const root = findWorkspaceRoot(startDirectory);
  if (!root) return merged;
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return merged;
  let local: Record<string, string>;
  try {
    local = parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return merged;
    throw error;
  }
  for (const [key, value] of Object.entries(local)) {
    if (OZON_CREDENTIAL_KEY.test(key) && !merged[key] && value) merged[key] = value;
  }
  return merged;
}

export function buildOzonMcpChildEnvironment(
  credentials: Record<string, string> = loadOzonEnvironment(),
  systemEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const child = buildSafeChildEnvironment(systemEnvironment);
  for (const key of LOCAL_OZON_KEYS) {
    const value = credentials[key];
    if (value) child[key] = value;
  }
  return child;
}

export function buildSafeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = environment[key];
    if (typeof value === 'string' && value) selected[key] = value;
  }
  return selected;
}

function selectOzonCredentials(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        OZON_CREDENTIAL_KEY.test(entry[0]) && typeof entry[1] === 'string',
    ),
  );
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
