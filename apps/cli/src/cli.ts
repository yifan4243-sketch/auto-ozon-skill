#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { CommandResult } from '@auto-ozon/contracts';
import {
  runOfflineNormalizeCommand,
  runListingPreparation,
  runSourceCommand,
  runCategoryInspect,
} from '@auto-ozon/workflows';
import {
  CliError,
  get1688ProfileStatus,
  getLast1688DebugEvent,
  list1688DebugEvents,
  list1688Profiles,
  run1688DoctorCommand,
  run1688LoginCommand,
  run1688LogoutCommand,
  run1688WhoamiCommand,
  show1688DebugEvent,
} from '@auto-ozon/adapters-1688';
import {
  currentCommandName,
  emit,
  isJson,
  isJsonV2,
  makeEnvelope,
  setOutputFlags,
} from '@auto-ozon/adapters-1688';
import { registerOzonCommands } from './commands/ozon.js';

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
      await run1688LoginCommand(opts);
    });

  yibaba
    .command('logout')
    .description('Log out and clear the local 1688 session')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      await run1688LogoutCommand(opts);
    });

  yibaba
    .command('whoami')
    .description('Show the current logged-in 1688 account')
    .option('--verify', 'Verify the session online')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      await run1688WhoamiCommand(opts);
    });

  yibaba
    .command('doctor')
    .description('Check Node.js, profile, Chromium, lock, session, and artifacts')
    .option('--no-launch', 'Skip the Chromium launch test')
    .option('--live', 'Run event log, artifact, and risk-event probes')
    .option('--profile <name>', 'Profile name')
    .action(async (opts) => {
      await run1688DoctorCommand(opts);
    });

  const profile = yibaba.command('profile').description('Inspect local 1688 profiles');
  profile
    .command('list')
    .description('List local profiles')
    .action(async () => {
      await list1688Profiles();
    });
  profile
    .command('status')
    .description('Show profile status')
    .argument('[name]', 'Profile name', 'default')
    .action(async (name) => {
      await get1688ProfileStatus(name);
    });

  const debug = yibaba.command('debug').description('Inspect recent command events and artifacts');
  debug
    .command('list')
    .description('List recent command events')
    .option('--limit <n>', 'Max requests to show', '20')
    .option('--failed', 'Only show failed requests')
    .action(async (opts) => {
      await list1688DebugEvents(opts);
    });
  debug
    .command('last')
    .description('Show the most recent command event')
    .option('--failed', 'Show the most recent failed request')
    .action(async (opts) => {
      await getLast1688DebugEvent(opts);
    });
  debug
    .command('show')
    .description('Show events and artifact location for a request')
    .argument('<requestId>', 'Request ID')
    .action(async (requestId) => {
      await show1688DebugEvent({ requestId });
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
    .option('--sort <sort>', 'Sort: relevance | price-asc | price-desc', 'relevance')
    .option('--price-min <n>', 'Minimum unit price')
    .option('--price-max <n>', 'Maximum unit price')
    .option('--sku-max <n>', 'Keep only products whose normalized SKU count is less than or equal to n')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .option('--schema-version <1|2>', 'Canonical product schema version', '1')
    .option('--products-dir <directory>', 'Save each product under <directory>/<offer_id>')
    .action(async (keyword, opts) => {
      const schemaVersion = parseSchemaVersion(opts.schemaVersion);
      validateProductsDir(schemaVersion, opts.productsDir);
      const input = {
        keyword,
        max: parseNumber(opts.max),
        sort: opts.sort,
        filters: {
          priceMin: parseOptionalNumber(opts.priceMin),
          priceMax: parseOptionalNumber(opts.priceMax),
        },
        skuMax: parseSkuMax(opts.skuMax),
        profile: opts.profile,
        headed: opts.headed,
      };
      const result = await runSourceCommand({
        source: { mode: 'keyword', ...input },
        schema_version: schemaVersion,
        products_dir: opts.productsDir,
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
    .option('--schema-version <1|2>', 'Canonical product schema version', '1')
    .option('--products-dir <directory>', 'Save each product under <directory>/<offer_id>')
    .action(async (imagePath, opts) => {
      const schemaVersion = parseSchemaVersion(opts.schemaVersion);
      validateProductsDir(schemaVersion, opts.productsDir);
      const input = {
        imagePath,
        max: parseNumber(opts.max),
        profile: opts.profile,
        headed: opts.headed,
      };
      emitCommandResult(
        await runSourceCommand({
          source: { mode: 'image', ...input },
          schema_version: schemaVersion,
          products_dir: opts.productsDir,
        }),
      );
    });

  source
    .command('offers')
    .description('Deep collect one or more 1688 offer IDs')
    .argument('<offerIds...>', 'One or more 1688 offer IDs')
    .option('--profile <name>', 'Profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .option('--schema-version <1|2>', 'Canonical product schema version', '1')
    .option('--products-dir <directory>', 'Save each product under <directory>/<offer_id>')
    .action(async (offerIds: string[], opts) => {
      const schemaVersion = parseSchemaVersion(opts.schemaVersion);
      validateProductsDir(schemaVersion, opts.productsDir);
      const input = {
        offerIds,
        profile: opts.profile,
        headed: opts.headed,
      };
      emitCommandResult(
        await runSourceCommand({
          source: { mode: 'offers', ...input },
          schema_version: schemaVersion,
          products_dir: opts.productsDir,
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
    .option('--schema-version <1|2>', 'Canonical product schema version', '1')
    .option('--products-dir <directory>', 'Save each product under <directory>/<offer_id>')
    .action(async (offerId, opts) => {
      const schemaVersion = parseSchemaVersion(opts.schemaVersion);
      validateProductsDir(schemaVersion, opts.productsDir);
      const input = {
        offerId,
        max: parseNumber(opts.max),
        profile: opts.profile,
        headed: opts.headed,
      };
      emitCommandResult(
        await runSourceCommand({
          source: { mode: 'similar', ...input },
          schema_version: schemaVersion,
          products_dir: opts.productsDir,
        }),
      );
    });

  source
    .command('normalize-v2')
    .description('Replay saved OfferResult JSON into CanonicalProductV2 offline')
    .option('--input <path>', 'OfferResult or OfferBatchResult JSON file')
    .option('--method <method>', 'keyword | image | offers | similar', 'offers')
    .option('--search-term <text>', 'Discovery search term to preserve')
    .option('--seed-offer-id <id>', 'Discovery seed offer ID to preserve')
    .option('--products-dir <directory>', 'Save each product under <directory>/<offer_id>')
    .action(async (opts) => {
      emitCommandResult(
        await runOfflineNormalizeCommand({
          input_path: opts.input ?? '',
          method: parseCollectionMethod(opts.method),
          search_term: opts.searchTerm,
          seed_offer_id: opts.seedOfferId,
          products_dir: opts.productsDir,
        }),
      );
    });

  registerOzonCommands(program, emitCommandResult, parseJsonParams, parseNumber);

  registerWorkflowCommands(program, emitCommandResult, parseNumber, parseSkuMax);

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

function registerWorkflowCommands(
  program: Command,
  emitCommandResult: (result: CommandResult<unknown>) => void,
  parseNumber: (raw: string | undefined) => number | undefined,
  parseSkuMax: (raw: string | undefined) => number | undefined,
): void {
  const workflow = program
    .command('workflow')
    .description('End-to-end automation workflows');

  const categoryCmd = workflow
    .command('category')
    .description('Category-related workflows: sourcing → decision → attributes');

  categoryCmd
    .command('inspect')
    .description('Source 1688 product → load CategoryDecision → fetch Ozon attributes')
    .argument('<keyword>', 'Search keyword for 1688 sourcing')
    .option('--max <n>', 'Maximum products to source', '1')
    .option('--sku-max <n>', 'Keep only products with at most n normalized SKUs')
    .option('--decision-file <path>', 'Path to CategoryDecisionV1 JSON file')
    .option('--products-dir <directory>', 'Product workspace root', 'data/products')
    .action(async (keyword, opts) => {
      emitCommandResult(
        await runCategoryInspect({
          keyword,
          max: parseNumber(opts.max) ?? 1,
          skuMax: parseSkuMax(opts.skuMax),
          decisionFile: opts.decisionFile,
          productsDir: opts.productsDir,
        }),
      );
    });

  const listing = workflow
    .command('listing')
    .description('Listing preparation workflows');

  listing
    .command('prepare')
    .description('Run or resume source → canonical → category → attributes → mapping')
    .argument('<keyword>', '1688 keyword used when the source step must run')
    .option('--run-id <id>', 'Reuse a run ID to resume from saved artifacts')
    .option('--decision-file <path>', 'Path to CategoryDecisionV1 JSON')
    .option('--start-from <step>', 'First step to execute', 'source-1688')
    .option('--stop-after <step>', 'Last step to execute', 'attribute-mapping')
    .option('--force-step <steps...>', 'Refresh this step and all downstream steps')
    .option('--continue-on-review', 'Continue when an upstream step needs review')
    .option('--sku-max <n>', 'Keep only products with at most n normalized SKUs')
    .option('--profile <name>', '1688 profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .action(async (keyword, opts) => {
      emitCommandResult(
        await runListingPreparation({
          run_id: opts.runId,
          source: {
            mode: 'keyword',
            keyword,
            max: 1,
            skuMax: parseSkuMax(opts.skuMax),
            profile: opts.profile,
            headed: opts.headed,
          },
          category_decision_file: opts.decisionFile,
          start_from: parseWorkflowStep(opts.startFrom),
          stop_after: parseWorkflowStep(opts.stopAfter),
          force_steps: (opts.forceStep ?? []).map(parseWorkflowStep),
          stop_on_review: !opts.continueOnReview,
        }),
      );
    });
}

function printCommandResult(result: CommandResult<unknown>): void {
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`error: ${error.code}: ${error.message}\n`);
    }
  }
  const data = result.data as
    | {
        schema_version?: number;
        total?: number;
        success?: number;
        failed?: number;
        items?: unknown[];
        summary?: {
          product_count: number;
          total_sku_count: number;
          validation_status_counts: Record<string, number>;
          package_match_counts: Record<string, number>;
          missing_package_sku_count: number;
          missing_weight_sku_count: number;
          unparsed_spec_sku_count: number;
        };
        integrity_report?: { status: string };
        artifacts?: { products_root: string } | null;
      }
    | undefined;
  if (data?.schema_version === 2 && data.summary && data.integrity_report) {
    process.stdout.write(
      formatCanonicalV2HumanSummary(result, {
        total: data.total,
        success: data.success,
        failed: data.failed,
        summary: data.summary,
        integrity_report: data.integrity_report,
        artifacts: data.artifacts,
      }),
    );
    return;
  }
  if (!result.ok) return;
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

export function formatCanonicalV2HumanSummary(
  result: CommandResult<unknown>,
  data: {
    total?: number;
    success?: number;
    failed?: number;
    summary: {
      product_count: number;
      total_sku_count: number;
      validation_status_counts: Record<string, number>;
      package_match_counts: Record<string, number>;
      missing_package_sku_count: number;
      missing_weight_sku_count: number;
      unparsed_spec_sku_count: number;
    };
    integrity_report: { status: string };
    artifacts?: { products_root: string } | null;
  },
): string {
    const status = data.summary.validation_status_counts;
    const matches = data.summary.package_match_counts;
    return (
      `${result.command}: ${data.success ?? 0}/${data.total ?? 0} collected` +
      ((data.failed ?? 0) > 0 ? `, ${data.failed} failed` : '') +
      '\n' +
      'schema: CanonicalProductV2\n' +
      `products: ${data.summary.product_count}\n` +
      `skus: ${data.summary.total_sku_count}\n` +
      `status: valid=${status.valid ?? 0} warning=${status.warning ?? 0} ` +
      `needs_review=${status.needs_review ?? 0} blocked=${status.blocked ?? 0}\n` +
      `package matches: sku_id=${matches.sku_id ?? 0} ` +
      `exact_spec=${matches.exact_spec ?? 0} none=${matches.none ?? 0}\n` +
      `missing packages: ${data.summary.missing_package_sku_count}\n` +
      `missing weights: ${data.summary.missing_weight_sku_count}\n` +
      `unparsed specs: ${data.summary.unparsed_spec_sku_count}\n` +
      `integrity: ${data.integrity_report.status}\n` +
      (data.artifacts ? `products: ${data.artifacts.products_root}\n` : '')
    );
}

export type ProductSchemaVersion = 1 | 2;

export function parseSchemaVersion(raw: string | undefined): ProductSchemaVersion {
  if (raw === undefined || raw === '1') return 1;
  if (raw === '2') return 2;
  throw new CliError(2, 'BAD_INPUT', '--schema-version must be exactly 1 or 2.');
}

function validateProductsDir(
  schemaVersion: ProductSchemaVersion,
  productsDir: string | undefined,
): void {
  if (productsDir && schemaVersion !== 2) {
    throw new CliError(
      2,
      'BAD_INPUT',
      '--products-dir requires --schema-version 2 for source collection commands.',
    );
  }
}

function parseSkuMax(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
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

function parseCollectionMethod(
  raw: string | undefined,
): 'keyword' | 'image' | 'offers' | 'similar' {
  const method = raw ?? 'offers';
  if (
    method === 'keyword' ||
    method === 'image' ||
    method === 'offers' ||
    method === 'similar'
  ) {
    return method;
  }
  throw new CliError(
    2,
    'BAD_INPUT',
    '--method must be keyword, image, offers, or similar.',
  );
}

function parseWorkflowStep(raw: string): import('@auto-ozon/contracts').WorkflowStepName {
  const steps = [
    'source-1688',
    'canonicalize-product',
    'category-decision',
    'category-attributes',
    'attribute-mapping',
    'draft-generation',
  ] as const;
  if (steps.includes(raw as (typeof steps)[number])) {
    return raw as (typeof steps)[number];
  }
  throw new CliError(2, 'BAD_INPUT', `Unknown workflow step: ${raw}`);
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
