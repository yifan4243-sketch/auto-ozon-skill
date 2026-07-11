import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../../apps/cli/src/cli.js';
import { OZON_MCP_TOOLS } from '../../../packages/adapters-ozon/src/config.js';
import { parseToolResult } from '../../../packages/adapters-ozon/src/mcp/parse-tool-result.js';
import { withPcdckClient } from '../../../packages/adapters-ozon/src/mcp/pcdck-client.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawnSync: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('parseToolResult', () => {
  it('parses structuredContent first', () => {
    expect(parseToolResult({ structuredContent: { ok: true }, content: [] })).toEqual({
      data: { ok: true },
      isError: false,
    });
  });

  it('parses JSON text content', () => {
    expect(
      parseToolResult({ content: [{ type: 'text', text: '{"count":2}' }] }),
    ).toMatchObject({
      data: { count: 2 },
      isError: false,
    });
  });

  it('wraps plain text content', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: 'plain result' }] })).toEqual({
      data: { text: 'plain result' },
      isError: false,
    });
  });

  it('preserves MCP isError', () => {
    expect(
      parseToolResult({ isError: true, content: [{ type: 'text', text: '{"message":"boom"}' }] }),
    ).toEqual({
      data: { message: 'boom' },
      isError: true,
    });
  });
});

describe('ozon doctor', () => {
  it('returns a clear missing-vendor result without starting MCP', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'statSync');
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(0, 'uv 0.4.0'));

    const { ozonDoctor } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonDoctor();

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('OZON_MCP_VENDOR_MISSING');
    expect(result.nextActions).toContain('git submodule update --init --recursive');
  });

  it('does not leak Ozon credentials', async () => {
    vi.stubEnv('OZON_CLIENT_ID', 'seller-secret-id');
    vi.stubEnv('OZON_API_KEY', 'seller-secret-key');
    vi.stubEnv('OZON_PERFORMANCE_CLIENT_ID', 'perf-secret-id');
    vi.stubEnv('OZON_PERFORMANCE_CLIENT_SECRET', 'perf-secret-value');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
    } as unknown as ReturnType<typeof fs.statSync>);
    vi.mocked(spawnSync).mockReturnValue(makeSpawnResult(0, 'ok'));
    mockPcdckClient({
      listTools: async () => ({
        tools: Object.values(OZON_MCP_TOOLS).map((name) => ({ name })),
      }),
    });

    const { ozonDoctor } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonDoctor();
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(true);
    expect(result.data?.credentials).toEqual({
      sellerCredentials: true,
      performanceCredentials: true,
    });
    expect(serialized).not.toContain('seller-secret-id');
    expect(serialized).not.toContain('seller-secret-key');
    expect(serialized).not.toContain('perf-secret-value');
  });
});

describe('ozon client execution guard', () => {
  it('wraps MCP tool errors into CommandResult errors', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ structuredContent: { operation_id: 'ReadOp', safety: 'read' } })
      .mockResolvedValueOnce({
        isError: true,
        content: [
          {
            type: 'text',
            text: '{"error_type":"server_error","message":"boom","retryable":true}',
          },
        ],
      });
    mockPcdckClient({
      listTools: async () => ({ tools: [{ name: 'ozon_call_method' }] }),
      callTool,
    });

    const { ozonCallMethod } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonCallMethod({ operationId: 'ReadOp', params: {} });

    expect(result.ok).toBe(false);
    expect(result.command).toBe('ozon.call');
    expect(result.errors[0]?.code).toBe('SERVER_ERROR');
  });

  it('blocks write and destructive methods locally', async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: { operation_id: 'WriteOp', safety: 'write' },
    });
    mockPcdckClient({
      listTools: async () => ({ tools: [{ name: 'ozon_call_method' }] }),
      callTool,
    });

    const { ozonCallMethod } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonCallMethod({ operationId: 'WriteOp', params: {} });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('OZON_WRITE_BLOCKED');
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('ozon_describe_method', { operation_id: 'WriteOp' });
  });

  it('returns execution disabled when ozon_call_method is not registered', async () => {
    const callTool = vi.fn();
    mockPcdckClient({
      listTools: async () => ({ tools: [{ name: 'ozon_search_methods' }] }),
      callTool,
    });

    const { ozonCallMethod } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonCallMethod({ operationId: 'ReadOp', params: {} });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('OZON_EXECUTION_TOOLS_DISABLED');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('maps fetch-all params to snake_case MCP arguments', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ structuredContent: { operation_id: 'ReadOp', safety: 'read' } })
      .mockResolvedValueOnce({ structuredContent: { items: [] } });
    mockPcdckClient({
      listTools: async () => ({ tools: [{ name: 'ozon_fetch_all' }] }),
      callTool,
    });

    const { ozonFetchAll } = await import('../../../packages/adapters-ozon/src/client.js');
    const result = await ozonFetchAll({
      operationId: 'ReadOp',
      params: { filter: { visibility: 'ALL' } },
      maxItems: 100,
    });

    expect(result.ok).toBe(true);
    expect(callTool).toHaveBeenNthCalledWith(1, 'ozon_describe_method', {
      operation_id: 'ReadOp',
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'ozon_fetch_all', {
      operation_id: 'ReadOp',
      params: { filter: { visibility: 'ALL' } },
      max_items: 100,
    });
  });
});

describe('ozon CLI registration', () => {
  it('registers ozon doctor, methods, and workflows', () => {
    const program = buildProgram();
    expect(findCommand(program, 'ozon doctor')).toBeDefined();
    expect(findCommand(program, 'ozon methods search')).toBeDefined();
    expect(findCommand(program, 'ozon methods describe')).toBeDefined();
    expect(findCommand(program, 'ozon workflows list')).toBeDefined();
    expect(findCommand(program, 'ozon workflows get')).toBeDefined();
  });

  it('does not expose write-operation command names in help', () => {
    const help = collectHelp(buildProgram()).toLowerCase();
    for (const forbidden of ['publish', 'submit', 'price update', 'stock update', 'archive', 'delete']) {
      expect(help).not.toContain(forbidden);
    }
  });

  it('returns INVALID_JSON_PARAMS for bad --params JSON', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    const program = buildProgram();
    await program.parseAsync([
      'node',
      'auto-ozon',
      'ozon',
      'call',
      'ProductAPI_GetProductList',
      '--params',
      '{bad',
      '--json',
    ]);

    const output = writes.join('');
    expect(output).toContain('INVALID_JSON_PARAMS');
    expect(output).toContain('"ok":false');
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])(
    'rejects invalid Ozon category IDs before starting MCP: %s',
    async (categoryId) => {
      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(
        (chunk: string | Uint8Array) => {
          writes.push(String(chunk));
          return true;
        },
      );

      await buildProgram().parseAsync([
        'node',
        'auto-ozon',
        'ozon',
        'category',
        'attributes',
        '--category-id',
        categoryId,
        '--type-id',
        '92499',
        '--json',
      ]);

      expect(writes.join('')).toContain('BAD_INPUT');
    },
  );
});

describe('withPcdckClient', () => {
  it('closes the client after success and failure', async () => {
    const closeOk = vi.fn();
    const clientOk = {
      connect: vi.fn(),
      close: closeOk,
    };
    await expect(
      withPcdckClient(async () => 'ok', () => clientOk as never),
    ).resolves.toBe('ok');
    expect(closeOk).toHaveBeenCalledTimes(1);

    const closeFail = vi.fn();
    const clientFail = {
      connect: vi.fn(),
      close: closeFail,
    };
    await expect(
      withPcdckClient(
        async () => {
          throw new Error('failed');
        },
        () => clientFail as never,
      ),
    ).rejects.toThrow('failed');
    expect(closeFail).toHaveBeenCalledTimes(1);
  });
});

function mockPcdckClient(implementation: {
  listTools?: () => Promise<unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
  vi.doMock('../../../packages/adapters-ozon/src/mcp/pcdck-client.js', () => {
    const cleanEnv = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    return {
      cleanEnv,
      resolveOzonMcpDir: () => 'C:\\repo\\vendor\\ozon-mcp',
      resolveRepoRoot: () => 'C:\\repo',
      withPcdckClient: async <T>(fn: (client: unknown) => Promise<T>) =>
        fn({
          listTools: implementation.listTools ?? (async () => ({ tools: [] })),
          callTool: implementation.callTool ?? (async () => ({ structuredContent: {} })),
        }),
      PcdckOzonMcpClient: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        listTools: implementation.listTools ?? (async () => ({ tools: [] })),
        callTool: implementation.callTool ?? (async () => ({ structuredContent: {} })),
        close: vi.fn(),
      })),
    };
  });
}

function makeSpawnResult(status: number, stdout = '', stderr = '') {
  return {
    status,
    stdout,
    stderr,
    pid: 0,
    output: [null, stdout, stderr],
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

function collectHelp(command: import('commander').Command): string {
  return [command.helpInformation(), ...command.commands.map(collectHelp)].join('\n');
}

function findCommand(
  command: import('commander').Command,
  path: string,
): import('commander').Command | undefined {
  const [head, ...tail] = path.split(' ');
  const child = command.commands.find((item) => item.name() === head);
  if (!child) return undefined;
  if (tail.length === 0) return child;
  return findCommand(child, tail.join(' '));
}
