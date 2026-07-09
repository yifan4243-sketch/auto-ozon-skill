import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class PcdckOzonMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;

  async connect(): Promise<void> {
    const ozonMcpDir = resolveOzonMcpDir();
    this.transport = new StdioClientTransport({
      command: process.env.OZON_MCP_COMMAND ?? 'uv',
      args: ['--directory', ozonMcpDir, 'run', 'ozon-mcp'],
      env: cleanEnv(process.env),
    });

    this.client = new Client(
      { name: 'auto-ozon-skill', version: '0.0.0' },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<unknown> {
    if (!this.client) throw new Error('Ozon MCP client is not connected.');
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('Ozon MCP client is not connected.');
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = undefined;
      this.transport = undefined;
    }
  }
}

export async function withPcdckClient<T>(
  fn: (client: PcdckOzonMcpClient) => Promise<T>,
  createClient: () => PcdckOzonMcpClient = () => new PcdckOzonMcpClient(),
): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function resolveOzonMcpDir(): string {
  if (process.env.OZON_MCP_DIR) return path.resolve(process.env.OZON_MCP_DIR);
  if (process.env.AUTO_OZON_ROOT) {
    return path.join(path.resolve(process.env.AUTO_OZON_ROOT), 'vendor', 'ozon-mcp');
  }
  return path.join(resolveRepoRoot(), 'vendor', 'ozon-mcp');
}

export function resolveRepoRoot(startDir = process.cwd()): string {
  const workspaceRoot = findUp(startDir, 'pnpm-workspace.yaml');
  if (workspaceRoot) return workspaceRoot;
  const packageRoot = findUp(startDir, 'package.json');
  return packageRoot ?? process.cwd();
}

function findUp(startDir: string, fileName: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, fileName))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
