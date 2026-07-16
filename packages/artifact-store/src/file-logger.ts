import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowLogger } from './execution-context.js';

export function createFileWorkflowLogger(
  runsRoot: string,
  runId: string,
): WorkflowLogger {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Invalid run ID: ${runId}`);
  }
  const directory = path.join(runsRoot, runId, 'logs');
  const file = path.join(directory, 'workflow.log');
  fs.mkdirSync(directory, { recursive: true });
  const write = (level: string, message: string, detail?: unknown) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(detail === undefined ? {} : { detail: sanitize(detail) }),
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  };
  return {
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  };
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      /cookie|token|secret|password|authorization/i.test(key)
        ? []
        : [[key, sanitize(child)]],
    ),
  );
}
