import { describe, expect, it } from 'vitest';
import { buildProgram } from '../apps/cli/src/cli.js';
import {
  CREDENTIAL_TOOLS,
  FULL_BRIDGE_CORE_TOOLS,
  OZON_MCP_TOOLS,
} from '../packages/adapters-ozon/src/config.js';

describe('complete Ozon MCP bridge', () => {
  it('registers all 15 PCDCK/ozon-mcp tools exactly once', () => {
    const names = Object.values(OZON_MCP_TOOLS);
    expect(names).toHaveLength(15);
    expect(new Set(names).size).toBe(15);
    expect(FULL_BRIDGE_CORE_TOOLS).toHaveLength(14);
    expect(CREDENTIAL_TOOLS).toEqual(['ozon_get_subscription_status']);
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
});
