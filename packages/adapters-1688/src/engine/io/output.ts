// Output shaping for human + agent consumers.
//
// `emit()` is called by each command's `run()` with both a human renderer
// and the raw data object. The four global flags (`--json`, `--pretty`,
// `--get`, `--pick`) plus the existing TTY/BB1688_JSON detection decide
// which branch wins:
//
//   --get <path>    Resolve a dot-path (`a.b[0].c`, `arr[*].x`) and print.
//                   Scalar → raw line. Object/array → JSON. Wildcards
//                   stream one line per element.
//   --pick <paths>  Comma-separated dot-paths → emit a JSON object with
//                   each path as a key.
//   --json          Force JSON even when stdout is a TTY.
//   --pretty        Indent JSON output by 2 spaces.
//
// CLI wiring sets these via `setOutputFlags()` from a commander preAction
// hook (see `src/cli.ts`).

let _forceJson = false;
let _pretty = false;
let _jsonV2 = false;
let _cmd: string | null = null;
let _getPath: string | null = null;
let _pickPaths: string[] | null = null;

const jsonModeFromEnv =
  !process.stdout.isTTY || process.env.BB1688_JSON === '1';

export interface CommandEnvelope<T> {
  ok: boolean;
  cmd: string | null;
  requestId: string | null;
  durationMs: number | null;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  verification?: unknown;
  warnings?: unknown;
  artifactDir?: string;
}

export interface OutputFlags {
  json?: boolean;
  jsonV2?: boolean;
  pretty?: boolean;
  get?: string;
  pick?: string;
  cmd?: string;
}

export function setOutputFlags(o: OutputFlags): void {
  _forceJson = !!o.json || !!o.jsonV2;
  _jsonV2 = !!o.jsonV2 || process.env.BB1688_JSON_V2 === '1';
  _pretty = !!o.pretty;
  _cmd = o.cmd ?? null;
  _getPath = o.get ?? null;
  _pickPaths = o.pick
    ? o.pick
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
}

export function isJson(): boolean {
  return _forceJson || jsonModeFromEnv;
}

export function isJsonV2(): boolean {
  return _jsonV2;
}

export function currentCommandName(): string | null {
  return _cmd;
}

function stringify(v: unknown): string {
  return _pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

export function makeEnvelope<T>(input: {
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  requestId?: string | null;
  durationMs?: number | null;
  cmd?: string | null;
  verification?: unknown;
  warnings?: unknown;
  artifactDir?: string;
}): CommandEnvelope<T> {
  const ok = input.error === undefined;
  return {
    ok,
    cmd: input.cmd ?? _cmd,
    requestId: input.requestId ?? null,
    durationMs: input.durationMs ?? null,
    ...(ok ? { data: input.data } : { error: input.error }),
    ...(input.verification !== undefined ? { verification: input.verification } : {}),
    ...(input.warnings !== undefined ? { warnings: input.warnings } : {}),
    ...(input.artifactDir ? { artifactDir: input.artifactDir } : {}),
  };
}

export function emit(opts: { human: () => void; data: unknown }): void {
  if (_jsonV2 && (_getPath !== null || _pickPaths !== null)) {
    throw new Error('--json-v2 cannot be combined with --get or --pick yet');
  }
  if (_getPath !== null) {
    const tokens = parsePath(_getPath);
    const result = resolve(opts.data, tokens);
    if (result.wildcard && Array.isArray(result.value)) {
      for (const el of result.value) emitOne(el);
    } else {
      emitOne(result.value);
    }
    return;
  }
  if (_pickPaths !== null) {
    const out: Record<string, unknown> = {};
    for (const p of _pickPaths) {
      const tokens = parsePath(p);
      out[p] = resolve(opts.data, tokens).value;
    }
    process.stdout.write(stringify(out) + '\n');
    return;
  }
  if (_jsonV2) {
    process.stdout.write(stringify(makeEnvelope({ data: opts.data })) + '\n');
  } else if (isJson()) {
    process.stdout.write(stringify(opts.data) + '\n');
  } else {
    opts.human();
  }
}

export function info(msg: string): void {
  if (!isJson()) process.stderr.write(`${msg}\n`);
}

// ---------- internal path resolver ----------

type PathToken =
  | { type: 'field'; name: string }
  | { type: 'index'; idx: number }
  | { type: 'wildcard' };

function parsePath(p: string): PathToken[] {
  const out: PathToken[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '.') {
      i++;
      continue;
    }
    if (p[i] === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) throw new Error(`unclosed [ in path: ${p}`);
      const inner = p.slice(i + 1, close);
      if (inner === '*') {
        out.push({ type: 'wildcard' });
      } else {
        const n = parseInt(inner, 10);
        if (!Number.isFinite(n)) {
          throw new Error(`bad index [${inner}] in path: ${p}`);
        }
        out.push({ type: 'index', idx: n });
      }
      i = close + 1;
      continue;
    }
    // field name until next '.' or '['
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    out.push({ type: 'field', name: p.slice(i, j) });
    i = j;
  }
  return out;
}

interface ResolveResult {
  wildcard: boolean;
  value: unknown;
}

function resolve(data: unknown, tokens: PathToken[]): ResolveResult {
  let cur: unknown = data;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (cur === null || cur === undefined) {
      return { wildcard: false, value: undefined };
    }
    if (tok.type === 'field') {
      if (typeof cur !== 'object' || Array.isArray(cur)) {
        return { wildcard: false, value: undefined };
      }
      cur = (cur as Record<string, unknown>)[tok.name];
    } else if (tok.type === 'index') {
      if (!Array.isArray(cur)) return { wildcard: false, value: undefined };
      cur = cur[tok.idx];
    } else {
      // wildcard
      if (!Array.isArray(cur)) return { wildcard: false, value: undefined };
      const rest = tokens.slice(i + 1);
      const expanded = cur.map((el) => resolve(el, rest).value);
      return { wildcard: true, value: expanded };
    }
  }
  return { wildcard: false, value: cur };
}

function emitOne(v: unknown): void {
  if (v === undefined) return;
  if (v === null) {
    process.stdout.write('null\n');
  } else if (typeof v === 'object') {
    process.stdout.write(stringify(v) + '\n');
  } else {
    process.stdout.write(String(v) + '\n');
  }
}
