#!/usr/bin/env node
import { runAutoOzonMcpServer } from './mcp-server.js';

runAutoOzonMcpServer().catch((error: unknown) => {
  process.stderr.write(`auto-ozon-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
