import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const SELLER_OZON_KEYS = [
  'OZON_CLIENT_ID',
  'OZON_API_KEY',
] as const;
const PERFORMANCE_OZON_KEYS = [
  'OZON_PERFORMANCE_CLIENT_ID',
  'OZON_PERFORMANCE_CLIENT_SECRET',
] as const;
const LOCAL_OZON_KEYS = [...SELLER_OZON_KEYS, ...PERFORMANCE_OZON_KEYS] as const;

const SAFE_CHILD_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL',
] as const;

const OZON_CREDENTIAL_KEY = /^OZON_(?:CLIENT_ID|API_KEY)(?:_[A-Za-z0-9_]+)?$|^OZON_PERFORMANCE_(?:CLIENT_ID|CLIENT_SECRET)(?:_[A-Za-z0-9_]+)?$/u;
export type OzonCredentialPurposeV1 = 'none' | 'seller' | 'performance' | 'both';
interface OzonCredentialScopeV1 { credentials: Record<string, string>; purpose: OzonCredentialPurposeV1 }
const credentialScope = new AsyncLocalStorage<OzonCredentialScopeV1>();
let commandCredentials: Record<string, string> = {};
let commandPurpose: OzonCredentialPurposeV1 = 'none';

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
  credentials: Record<string, string> = getActiveOzonMcpCredentials(),
  systemEnvironment: NodeJS.ProcessEnv = process.env,
  purpose: OzonCredentialPurposeV1 = getActiveOzonMcpCredentialPurpose(),
): Record<string, string> {
  const child = buildSafeChildEnvironment(systemEnvironment);
  for (const key of credentialKeysForPurpose(purpose)) {
    const value = credentials[key];
    if (value) child[key] = value;
  }
  return child;
}

/**
 * Run one workflow with only the credentials resolved for its selected store.
 * The scope is async-safe, so concurrent multi-store jobs cannot see each
 * other's Seller credentials.
 */
export function withOzonMcpCredentials<T>(
  credentials: Record<string, string>,
  operation: () => Promise<T>,
  purpose: OzonCredentialPurposeV1 = 'seller',
): Promise<T> {
  return credentialScope.run({ credentials: selectStandardMcpCredentials(credentials), purpose }, operation);
}

/** CLI processes execute one command. This setter is cleared/replaced by the
 * `ozon` parent command before its child action starts. Library workflows use
 * `withOzonMcpCredentials` instead. */
export function setOzonMcpCommandCredentials(
  credentials: Record<string, string>,
  purpose: OzonCredentialPurposeV1 = 'both',
): void {
  commandCredentials = selectStandardMcpCredentials(credentials);
  commandPurpose = purpose;
}

export function getActiveOzonMcpCredentials(): Record<string, string> {
  return { ...(credentialScope.getStore()?.credentials ?? commandCredentials) };
}

export function getActiveOzonMcpCredentialPurpose(): OzonCredentialPurposeV1 {
  return credentialScope.getStore()?.purpose ?? commandPurpose;
}

function credentialKeysForPurpose(purpose: OzonCredentialPurposeV1): readonly string[] {
  if (purpose === 'seller') return SELLER_OZON_KEYS;
  if (purpose === 'performance') return PERFORMANCE_OZON_KEYS;
  if (purpose === 'both') return LOCAL_OZON_KEYS;
  return [];
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

function selectStandardMcpCredentials(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(LOCAL_OZON_KEYS.flatMap((key) => environment[key] ? [[key, environment[key]]] : []));
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
