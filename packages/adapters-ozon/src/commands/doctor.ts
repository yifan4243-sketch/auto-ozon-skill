import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  CREDENTIAL_TOOLS,
  DISCOVERY_TOOLS,
  EXECUTION_TOOLS,
  EXECUTION_TOOLS_NEXT_ACTIONS,
  FULL_BRIDGE_CORE_TOOLS,
  REFERENCE_TOOLS,
  SUBMODULE_NEXT_ACTIONS,
  UV_NEXT_ACTIONS,
  credentialStatus,
  errorResult,
  extractToolNames,
  okResult,
  sanitizeSecretText,
  toolAvailability,
} from '../config.js';
import { PcdckOzonMcpClient, cleanEnv, resolveOzonMcpDir } from '../mcp/pcdck-client.js';
import type { OzonCommandResult, OzonDoctorCheck, OzonDoctorData } from '../types.js';

export async function ozonDoctor(): Promise<OzonCommandResult<OzonDoctorData>> {
  const vendorDir = resolveOzonMcpDir();
  const checks: OzonDoctorCheck[] = [];
  const warnings = [];
  const errors = [];
  const nextActions = new Set<string>();
  const credentials = credentialStatus();

  const vendorExists = directoryExists(vendorDir);
  checks.push({
    name: 'vendor/ozon-mcp',
    status: vendorExists ? 'ok' : 'error',
    message: vendorExists ? vendorDir : `${vendorDir} is missing.`,
  });
  if (!vendorExists) {
    errors.push({
      code: 'OZON_MCP_VENDOR_MISSING',
      message: 'vendor/ozon-mcp is missing. Initialize the PCDCK/ozon-mcp submodule.',
      recoverable: true,
    });
    SUBMODULE_NEXT_ACTIONS.forEach((action) => nextActions.add(action));
  }

  const uvCheck = checkUv();
  checks.push({
    name: 'uv executable',
    status: uvCheck.ok ? 'ok' : 'error',
    message: uvCheck.message,
  });
  if (!uvCheck.ok) {
    errors.push({
      code: 'UV_NOT_FOUND',
      message: 'uv is required to run vendor/ozon-mcp.',
      recoverable: true,
    });
    UV_NEXT_ACTIONS.forEach((action) => nextActions.add(action));
  }

  const helpCheck =
    vendorExists && uvCheck.ok
      ? checkOzonMcpHelp(vendorDir)
      : { ok: false, message: 'skipped' };
  checks.push({
    name: 'uv run ozon-mcp --help',
    status: helpCheck.ok ? 'ok' : vendorExists && uvCheck.ok ? 'error' : 'skipped',
    message: helpCheck.message,
  });
  if (vendorExists && uvCheck.ok && !helpCheck.ok) {
    errors.push({
      code: 'OZON_MCP_HELP_FAILED',
      message: 'uv run ozon-mcp --help failed.',
      recoverable: true,
    });
    SUBMODULE_NEXT_ACTIONS.forEach((action) => nextActions.add(action));
  }

  let mcpStartOk = false;
  let toolsListOk = false;
  let toolNames: string[] = [];
  if (vendorExists && uvCheck.ok && helpCheck.ok) {
    const client = new PcdckOzonMcpClient();
    try {
      await client.connect();
      mcpStartOk = true;
      const listResult = await client.listTools();
      toolsListOk = true;
      toolNames = extractToolNames(listResult).sort();
    } catch (error) {
      errors.push({
        code: mcpStartOk ? 'OZON_MCP_LIST_TOOLS_FAILED' : 'OZON_MCP_START_FAILED',
        message: sanitizeSecretText(error),
        recoverable: true,
      });
    } finally {
      await client.close();
    }
  }

  checks.push({
    name: 'MCP startup',
    status: mcpStartOk ? 'ok' : vendorExists && uvCheck.ok && helpCheck.ok ? 'error' : 'skipped',
    message: mcpStartOk ? 'MCP server started.' : 'skipped',
  });
  checks.push({
    name: 'tools/list',
    status: toolsListOk ? 'ok' : mcpStartOk ? 'error' : 'skipped',
    message: toolsListOk ? `${toolNames.length} tools listed.` : 'skipped',
  });

  const discoveryTools = toolAvailability(toolNames, DISCOVERY_TOOLS);
  const referenceTools = toolAvailability(toolNames, REFERENCE_TOOLS);
  const executionTools = toolAvailability(toolNames, EXECUTION_TOOLS);
  const credentialTools = toolAvailability(toolNames, CREDENTIAL_TOOLS);
  const fullBridgeCoreTools = toolAvailability(toolNames, FULL_BRIDGE_CORE_TOOLS);

  addToolCheck(checks, 'discovery tools', discoveryTools, toolsListOk);
  addToolCheck(checks, 'reference tools', referenceTools, toolsListOk);
  addToolCheck(checks, 'execution tools', executionTools, toolsListOk, 'warning');
  addToolCheck(checks, 'full bridge core tools', fullBridgeCoreTools, toolsListOk);

  checks.push({
    name: 'credential-dependent tools',
    status: credentialTools.available
      ? 'ok'
      : toolsListOk && credentials.sellerCredentials
        ? 'error'
        : toolsListOk
          ? 'skipped'
          : 'skipped',
    message: credentialTools.available
      ? 'Credential-dependent tools are available.'
      : credentials.sellerCredentials
        ? `Missing: ${credentialTools.missing.join(', ')}`
        : 'Seller credentials are not configured; subscription-status tool is expected to be absent.',
  });

  if (toolsListOk && !fullBridgeCoreTools.available) {
    errors.push({
      code: 'OZON_FULL_BRIDGE_TOOLS_MISSING',
      message: `Required Ozon MCP tools are missing: ${fullBridgeCoreTools.missing.join(', ')}`,
      recoverable: true,
    });
  }
  if (toolsListOk && credentials.sellerCredentials && !credentialTools.available) {
    errors.push({
      code: 'OZON_CREDENTIAL_TOOLS_MISSING',
      message: `Credential-dependent Ozon MCP tools are missing: ${credentialTools.missing.join(', ')}`,
      recoverable: true,
    });
  }

  if (toolsListOk && fullBridgeCoreTools.available && !credentials.sellerCredentials) {
    warnings.push({
      code: 'OZON_CREDENTIALS_MISSING',
      message:
        'The complete offline/discovery bridge is available; live account calls and subscription status need seller credentials.',
    });
    EXECUTION_TOOLS_NEXT_ACTIONS.forEach((action) => nextActions.add(action));
  }

  const data: OzonDoctorData = {
    vendorDir,
    vendorExists,
    uvExecutable: uvCheck.ok,
    helpOk: helpCheck.ok,
    mcpStartOk,
    toolsListOk,
    toolCount: toolNames.length,
    toolNames,
    discoveryTools,
    referenceTools,
    executionTools,
    credentialTools,
    fullBridgeCoreTools,
    credentials,
    checks,
  };

  if (errors.length > 0) {
    const [first, ...rest] = errors;
    return {
      ...errorResult('ozon.doctor', first, [...nextActions], warnings, data),
      errors: [first, ...rest],
    };
  }
  return okResult('ozon.doctor', data, warnings, [...nextActions]);
}

function addToolCheck(
  checks: OzonDoctorCheck[],
  name: string,
  availability: { available: boolean; missing: string[] },
  toolsListOk: boolean,
  missingStatus: 'error' | 'warning' = 'error',
): void {
  checks.push({
    name,
    status: availability.available ? 'ok' : toolsListOk ? missingStatus : 'skipped',
    message: availability.available
      ? `${name[0]?.toUpperCase() ?? ''}${name.slice(1)} are available.`
      : `Missing: ${availability.missing.join(', ')}`,
  });
}

function directoryExists(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function checkUv(): { ok: boolean; message: string } {
  const command = process.env.OZON_MCP_COMMAND ?? 'uv';
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    env: cleanEnv(process.env),
    timeout: 15_000,
  });
  if (result.error) return { ok: false, message: sanitizeSecretText(result.error) };
  if (result.status === 0) return { ok: true, message: sanitizeSecretText(result.stdout).trim() };
  return { ok: false, message: sanitizeSecretText(result.stderr || result.stdout || result.status) };
}

function checkOzonMcpHelp(vendorDir: string): { ok: boolean; message: string } {
  const command = process.env.OZON_MCP_COMMAND ?? 'uv';
  const result = spawnSync(command, ['--directory', vendorDir, 'run', 'ozon-mcp', '--help'], {
    encoding: 'utf8',
    env: cleanEnv(process.env),
    timeout: 30_000,
  });
  if (result.error) return { ok: false, message: sanitizeSecretText(result.error) };
  if (result.status === 0) return { ok: true, message: 'ozon-mcp help OK' };
  return { ok: false, message: sanitizeSecretText(result.stderr || result.stdout || result.status) };
}
