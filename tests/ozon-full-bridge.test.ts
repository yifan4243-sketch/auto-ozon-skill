import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../apps/cli/src/cli.js';
import { ensureExecutionToolAndReadSafety } from '../packages/adapters-ozon/src/commands/call.js';
import {
  CREDENTIAL_TOOLS,
  EXECUTION_TOOLS,
  FULL_BRIDGE_CORE_TOOLS,
  OZON_MCP_TOOLS,
  credentialStatus,
} from '../packages/adapters-ozon/src/config.js';
import {
  PcdckOzonMcpClient,
  withPcdckClient,
} from '../packages/adapters-ozon/src/mcp/pcdck-client.js';

describe('complete Ozon MCP bridge', () => {
  it('registers all 15 PCDCK/ozon-mcp tools exactly once', () => {
    const names = Object.values(OZON_MCP_TOOLS);
    const conditionallyRegistered = [...EXECUTION_TOOLS, ...CREDENTIAL_TOOLS];

    expect(names).toHaveLength(15);
    expect(new Set(names).size).toBe(15);
    expect(FULL_BRIDGE_CORE_TOOLS).toHaveLength(12);
    expect(EXECUTION_TOOLS).toEqual(['ozon_call_method', 'ozon_fetch_all']);
    expect(CREDENTIAL_TOOLS).toEqual(['ozon_get_subscription_status']);
    expect(new Set([...FULL_BRIDGE_CORE_TOOLS, ...conditionallyRegistered])).toEqual(
      new Set(names),
    );
  });

  it('recognizes Seller and Performance credential modes independently', () => {
    expect(credentialStatus({})).toEqual({
      sellerCredentials: false,
      performanceCredentials: false,
    });
    expect(
      credentialStatus({
        OZON_CLIENT_ID: 'seller',
        OZON_API_KEY: 'key',
      }),
    ).toEqual({ sellerCredentials: true, performanceCredentials: false });
    expect(
      credentialStatus({
        OZON_PERFORMANCE_CLIENT_ID: 'performance',
        OZON_PERFORMANCE_CLIENT_SECRET: 'secret',
      }),
    ).toEqual({ sellerCredentials: false, performanceCredentials: true });
  });

  it('exposes the complete CLI command groups', () => {
    const program = buildProgram();
    const ozon = program.commands.find((command) => command.name() === 'ozon');
    expect(ozon).toBeDefined();

    const groupNames = ozon?.commands.map((command) => command.name()) ?? [];
    expect(groupNames).toEqual(
      expect.arrayContaining([
        'doctor',
        'sections',
        'methods',
        'reference',
        'subscription',
        'call',
        'fetch-all',
        'workflows',
      ]),
    );

    const methods = ozon?.commands.find((command) => command.name() === 'methods');
    expect(methods?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['search', 'describe', 'related', 'examples']),
    );

    const reference = ozon?.commands.find((command) => command.name() === 'reference');
    expect(reference?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['rate-limits', 'errors', 'swagger-meta']),
    );

    const subscription = ozon?.commands.find((command) => command.name() === 'subscription');
    expect(subscription?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['status', 'methods']),
    );
  });

  it('always closes the MCP client when connection fails', async () => {
    const close = vi.fn(async () => undefined);
    const fakeClient = {
      connect: vi.fn(async () => {
        throw new Error('connect failed');
      }),
      close,
    } as unknown as PcdckOzonMcpClient;

    await expect(
      withPcdckClient(async () => 'unreachable', () => fakeClient),
    ).rejects.toThrow('connect failed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('allows only read methods through the generic execution guard', async () => {
    const readClient = fakeGuardClient('read');
    const writeClient = fakeGuardClient('write');

    await expect(
      ensureExecutionToolAndReadSafety(
        readClient,
        OZON_MCP_TOOLS.callMethod,
        'ozon.call',
        'ReadOperation',
      ),
    ).resolves.toBeNull();

    const blocked = await ensureExecutionToolAndReadSafety(
      writeClient,
      OZON_MCP_TOOLS.callMethod,
      'ozon.call',
      'WriteOperation',
    );
    expect(blocked?.ok).toBe(false);
    expect(blocked?.errors[0]?.code).toBe('OZON_WRITE_BLOCKED');
  });

  it('reports disabled execution tools when credentials are absent', async () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: [] })),
    } as unknown as PcdckOzonMcpClient;

    const result = await ensureExecutionToolAndReadSafety(
      client,
      OZON_MCP_TOOLS.callMethod,
      'ozon.call',
      'AnyOperation',
    );
    expect(result?.ok).toBe(false);
    expect(result?.errors[0]?.code).toBe('OZON_EXECUTION_TOOLS_DISABLED');
  });
});

function fakeGuardClient(safety: 'read' | 'write' | 'destructive'): PcdckOzonMcpClient {
  return {
    listTools: vi.fn(async () => ({
      tools: [{ name: OZON_MCP_TOOLS.callMethod }],
    })),
    callTool: vi.fn(async () => ({
      isError: false,
      structuredContent: { safety },
    })),
  } as unknown as PcdckOzonMcpClient;
}
