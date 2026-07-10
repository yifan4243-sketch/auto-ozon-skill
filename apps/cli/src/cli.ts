#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { CommandResult } from '../../../packages/contracts/src/command-result.js';
import {
  get1688Offers,
  get1688Similar,
  search1688ByImage,
  search1688ByKeyword,
} from '../../../packages/adapters-1688/src/client.js';
import {
  ozonCallMethod,
  ozonDescribeMethod,
  ozonDoctor,
  ozonFetchAll,
  ozonGetWorkflow,
  ozonListWorkflows,
  ozonSearchMethods,
} from '../../../packages/adapters-ozon/src/client.js';
import { CliError } from '../../../packages/adapters-1688/src/engine/io/errors.js';
import {
  currentCommandName,
  emit,
  isJson,
  isJsonV2,
  makeEnvelope,
  setOutputFlags,
} from '../../../packages/adapters-1688/src/engine/io/output.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('auto-ozon')
    .description('Auto Ozon sourcing and marketplace operations')
    .version('0.0.0');

  const yibaba = program.command('1688').description('1688 sourcing session tools');

  yibaba
    .command('login')
    .description('Log in to 1688 by scanning a QR code')
    .option('--force', 'Re-login even if a session already exists')
    .option('--timeout <seconds>', 'Seconds to wait for QR scan', '300')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a real browser window instead of terminal QR')
    .action(async (opts) => {
      const { run } = await import('../../../packages/adapters-1688/src/engine/commands/login.js');
      await run(opts);
    });

  yibaba
    .command('logout')
    .description('Log out and clear the local 1688 session')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      const { run } = await import('../../../packages/adapters-1688/src/engine/commands/logout.js');
      await run(opts);
    });

  yibaba
    .command('whoami')
    .description('Show the current logged-in 1688 account')
    .option('--verify', 'Verify the session online')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      const { run } = await import('../../../packages/adapters-1688/src/engine/commands/whoami.js');
      await run(opts);
    });

  yibaba
    .command('doctor')
    .description('Check Node.js, profile, Chromium, lock, session, and artifacts')
    .option('--no-launch', 'Skip the Chromium launch test')
    .option('--live', 'Run event log, artifact, and risk-event probes')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      const { run } = await import('../../../packages/adapters-1688/src/engine/commands/doctor.js');
      await run(opts);
    });

  const profile = yibaba.command('profile').description('Inspect local 1688 profiles');
  profile
    .command('list')
    .description('List local profiles')
    .action(async () => {
      const { list } = await import('../../../packages/adapters-1688/src/engine/commands/profile.js');
      await list();
    });
  profile
    .command('status')
    .description('Show profile status')
    .argument('[name]', 'Profile name', 'default')
    .action(async (name) => {
      const { status } = await import('../../../packages/adapters-1688/src/engine/commands/profile.js');
      await status(name);
    });

  const debug = yibaba.command('debug').description('Inspect recent command events and artifacts');
  debug
    .command('list')
    .description('List recent command events')
    .option('--limit <n>', 'Max requests to show', '20')
    .option('--failed', 'Only show failed requests')
    .action(async (opts) => {
      const { list } = await import('../../../packages/adapters-1688/src/engine/commands/debug.js');
      await list(opts);
    });
  debug
    .command('last')
    .description('Show the most recent command event')
    .option('--failed', 'Show the most recent failed request')
    .action(async (opts) => {
      const { last } = await import('../../../packages/adapters-1688/src/engine/commands/debug.js');
      await last(opts);
    });
  debug
    .command('show')
    .description('Show events and artifact location for a request')
    .argument('<requestId>', 'Request ID')
    .action(async (requestId) => {
      const { show } = await import('../../../packages/adapters-1688/src/engine/commands/debug.js');
      await show({ requestId });
    });

  const source = program.command('source').description('Source products for Ozon drafts');

  source
    .command('keyword')
    .description('Search 1688 by keyword and deep collect product details')
    .argument('<keyword>', 'Keyword to search')
    .option(
      '--max <n>',
      'Maximum returned products; with --sku-max this is the qualified-product target',
      '20',
    )
    .option('--sort <sort>', 'Sort: relevance | best-selling | price-asc | price-desc', 'relevance')
    .option('--price-min <n>', 'Minimum unit price')
    .option('--price-max <n>', 'Maximum unit price')
    .option('--province <name>', 'Filter supplier province')
    .option('--city <name>', 'Filter supplier city')
    .option('--verified <kind>', 'Filter: any | factory | business | super-factory', 'any')
    .option('--min-turnover <n>', 'Minimum parsed turnover/order count')
    .option('--exclude-ads', 'Exclude P4P/ad results')
    .option(
      '--sku-max <n>',
      'Keep only products whose normalized SKU count is less than or equal to n',
      parseSkuMax,
    )
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .action(async (keyword, opts) => {
      const result = await search1688ByKeyword({
        keyword,
        max: parseNumber(opts.max),
        sort: opts.sort,
        filters: {
          priceMin: parseOptionalNumber(opts.priceMin),
          priceMax: parseOptionalNumber(opts.priceMax),
          province: opts.province,
          city: opts.city,
          verified: opts.verified,
          minTurnover: parseOptionalNumber(opts.minTurnover),
          excludeAds: opts.excludeAds,
        },
        skuMax: opts.skuMax,
        profile: opts.profile,
        headed: opts.headed,
      });
      emitCommandResult(result);
    });

  source
    .command('image')
    .description('Search 1688 by image and deep collect product details')
    .argument('<imagePath>', 'Local image path')
    .option('--max <n>', 'Maximum number of candidates', '20')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .action(async (imagePath, opts) => {
      emitCommandResult(
        await search1688ByImage({
          imagePath,
          max: parseNumber(opts.max),
          profile: opts.profile,
          headed: opts.headed,
        }),
      );
    });

  source
    .command('offers')
    .description('Deep collect one or more 1688 offer IDs')
    .argument('<offerIds...>', 'One or more 1688 offer IDs')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .action(async (offerIds: string[], opts) => {
      emitCommandResult(
        await get1688Offers({
          offerIds,
          profile: opts.profile,
          headed: opts.headed,
        }),
      );
    });

  source
    .command('similar')
    .description('Find official similar offers and deep collect product details')
    .argument('<offerId>', 'Seed 1688 offer ID')
    .option('--max <n>', 'Maximum number of candidates', '20')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .action(async (offerId, opts) => {
      emitCommandResult(
        await get1688Similar({
          offerId,
          max: parseNumber(opts.max),
          profile: opts.profile,
          headed: opts.headed,
        }),
      );
    });

  const ozon = program
    .command('ozon')
    .description('External PCDCK/ozon-mcp bridge for Ozon discovery and read-only calls');

  ozon
    .command('doctor')
    .description('Check vendor/ozon-mcp, uv, MCP startup, tools, and credentials')
    .action(async () => {
      emitCommandResult(await ozonDoctor());
    });

  const ozonMethods = ozon.command('methods').description('Search and describe Ozon API methods');
  ozonMethods
    .command('search')
    .description('Search PCDCK Ozon MCP methods')
    .argument('<query>', 'Search query')
    .option('--limit <n>', 'Maximum number of methods', '10')
    .action(async (query, opts) => {
      emitCommandResult(
        await ozonSearchMethods({
          query,
          limit: parseNumber(opts.limit),
        }),
      );
    });
  ozonMethods
    .command('describe')
    .description('Describe one Ozon API method')
    .argument('<operationId>', 'Ozon operationId')
    .action(async (operationId) => {
      emitCommandResult(await ozonDescribeMethod({ operationId }));
    });

  ozon
    .command('call')
    .description('Call a read-only Ozon method through PCDCK/ozon-mcp')
    .argument('<operationId>', 'Ozon operationId')
    .option('--params <json>', 'JSON params object', '{}')
    .action(async (operationId, opts) => {
      const params = parseJsonParams(opts.params, 'ozon.call');
      if (!params.ok) {
        emitCommandResult(params.result);
        return;
      }
      emitCommandResult(await ozonCallMethod({ operationId, params: params.value }));
    });

  ozon
    .command('fetch-all')
    .description('Fetch all pages for a read-only paginated Ozon method')
    .argument('<operationId>', 'Ozon operationId')
    .option('--params <json>', 'JSON params object', '{}')
    .option('--max-items <n>', 'Maximum items to fetch', '10000')
    .action(async (operationId, opts) => {
      const params = parseJsonParams(opts.params, 'ozon.fetchAll');
      if (!params.ok) {
        emitCommandResult(params.result);
        return;
      }
      emitCommandResult(
        await ozonFetchAll({
          operationId,
          params: params.value,
          maxItems: parseNumber(opts.maxItems),
        }),
      );
    });

  const ozonWorkflows = ozon
    .command('workflows')
    .description('List and inspect curated PCDCK Ozon MCP workflows');
  ozonWorkflows
    .command('list')
    .description('List Ozon MCP workflows')
    .action(async () => {
      emitCommandResult(await ozonListWorkflows());
    });
  ozonWorkflows
    .command('get')
    .description('Get one Ozon MCP workflow')
    .argument('<name>', 'Workflow name')
    .action(async (name) => {
      emitCommandResult(await ozonGetWorkflow({ name }));
    });

  addOutputFlagsToAll(program);
  program.hook('preAction', (_thisCmd, actionCmd) => {
    const opts = actionCmd.optsWithGlobals() as {
      json?: boolean;
      jsonV2?: boolean;
      pretty?: boolean;
      get?: string;
      pick?: string;
    };
    setOutputFlags({
      json: opts.json,
      jsonV2: opts.jsonV2,
      pretty: opts.pretty,
      get: opts.get,
      pick: opts.pick,
      cmd: actionCmd.name(),
    });
  });

  return program;
}

function addOutputFlagsToAll(command: Command): void {
  for (const child of command.commands) {
    addOutputFlagsToAll(child);
    child.option('--json', 'Force JSON output even when stdout is a TTY');
    child.option('--json-v2', 'Emit an opt-in response envelope');
    child.option('--pretty', 'Pretty-print JSON output');
    child.option('--get <path>', 'Print one field by dot-path');
    child.option('--pick <paths>', 'Comma-separated dot-paths to emit as an object');
  }
}

function emitCommandResult(result: CommandResult<unknown>): void {
  emit({
    human: () => printCommandResult(result),
    data: result,
  });
  if (!result.ok) process.exitCode = 1;
}

function printCommandResult(result: CommandResult<unknown>): void {
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`error: ${error.code}: ${error.message}\n`);
    }
    return;
  }
  const data = result.data as { total?: number; success?: number; failed?: number; items?: unknown[] } | undefined;
  if (data && typeof data === 'object' && 'success' in data) {
    process.stdout.write(
      `${result.command}: ${data.success ?? 0}/${data.total ?? 0} collected` +
        ((data.failed ?? 0) > 0 ? `, ${data.failed} failed` : '') +
        '\n',
    );
    return;
  }
  process.stdout.write(`${result.command}: ok\n`);
}

function parseSkuMax(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(2, 'BAD_INPUT', '--sku-max must be a positive integer.');
  }
  return value;
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseOptionalNumber(raw: string | undefined): number | null {
  const value = parseNumber(raw);
  return value === undefined ? null : value;
}

function parseJsonParams(
  raw: string | undefined,
  command: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: CommandResult<unknown> } {
  try {
    const value = JSON.parse(raw ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object');
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        command,
        warnings: [],
        errors: [
          {
            code: 'INVALID_JSON_PARAMS',
            message: '--params must be valid JSON.',
            recoverable: true,
          },
        ],
        nextActions: [
          'Use a valid JSON string, for example: --params \'{"filter":{"visibility":"ALL"}}\'',
        ],
      },
    };
  }
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CliError) {
      if (isJsonV2()) {
        process.stderr.write(
          JSON.stringify(
            makeEnvelope({
              cmd: currentCommandName(),
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            }),
          ) + '\n',
        );
      } else if (isJson()) {
        process.stderr.write(
          JSON.stringify({
            ok: false,
            code: error.code,
            message: error.message,
            details: error.details,
          }) + '\n',
        );
      } else if (error.message) {
        process.stderr.write(`error: ${error.message}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

if (isCliEntrypoint()) {
  await runCli();
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}
