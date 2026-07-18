#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type {
  AttributeMappingAgentInputV1,
  CommandResult,
  CostPricingAgentInputV1,
  CostPricingProfileV1,
  ImageReviewAgentInputV1,
} from '@auto-ozon/contracts';
import {
  runOfflineNormalizeCommand,
  runListingPreparation,
  runSourceCommand,
  runCategoryInspect,
  runListingPublish,
  getListingPublishStatus,
  createBatchWorkflow,
  getBatchWorkflowStatus,
  runBatchWorkflow,
  runSetupDoctor,
  refreshOzonCategoryTree,
  loadConfiguredImageGeneration,
  setStorePublishingConsent,
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
import { getBatchDecisionTasks, startReviewConsole, submitBatchAgentDecision } from '@auto-ozon/control-plane';

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

  const source = program.command('source').description('Collect and normalize 1688 products');

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

  const setup = program
    .command('setup')
    .description('Configure and validate local accounts, stores, consent, snapshots, browser, and Ozon MCP');
  setup.command('doctor')
    .description('Run the complete read-only setup readiness report')
    .action(async () => {
      emitCommandResult(await runSetupDoctor());
    });
  const setupPublishing = setup.command('publishing').description('Explicitly grant or revoke store-level automatic publishing consent');
  setupPublishing.command('enable')
    .requiredOption('--store-id <Client-Id>', 'Store to authorize')
    .option('--actor <name>', 'Audit actor', process.env.USERNAME ?? process.env.USER ?? 'local-user')
    .action(async (opts) => {
      emitCommandResult(await setStorePublishingConsent({
        store_id: opts.storeId,
        enabled: true,
        actor: opts.actor,
        source: 'setup_cli',
      }));
    });
  setupPublishing.command('disable')
    .requiredOption('--store-id <Client-Id>', 'Store whose consent is revoked')
    .option('--actor <name>', 'Audit actor', process.env.USERNAME ?? process.env.USER ?? 'local-user')
    .action(async (opts) => {
      emitCommandResult(await setStorePublishingConsent({
        store_id: opts.storeId,
        enabled: false,
        actor: opts.actor,
        source: 'setup_cli',
      }));
    });

  const reviewConsole = program
    .command('review-console')
    .description('Start the explicit foreground review console on localhost');
  reviewConsole
    .command('start')
    .description('Start the local single-user reviewer; never exposes API keys')
    .option('--port <n>', 'Local port; 0 selects an available port', '0')
    .action(async (opts) => {
      const parsedPort = parseNumber(opts.port);
      if (parsedPort === undefined || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
        throw new CliError(2, 'BAD_INPUT', '--port must be an integer from 0 to 65535.');
      }
      const port = parsedPort;
      const running = await startReviewConsole({ port });
      process.stdout.write(`Auto Ozon review console: ${running.url}\nPress Ctrl+C to stop.\n`);
    });

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

  const batch = workflow.command('batch').description('Create and inspect foreground multi-product jobs');
  batch.command('create')
    .description('Create a keyword batch, or omit --keyword to use annual Russian market selection')
    .requiredOption('--batch-id <id>', 'Stable local batch ID')
    .requiredOption('--store-id <Client-Id>', 'Target Ozon Seller Client-Id')
    .requiredOption('--count <n>', 'Requested Ozon listing/SKU count')
    .requiredOption('--profiles <names>', 'At least two 1688 profile names separated by commas')
    .option('--keyword <keyword>', 'Explicit 1688 keyword; omit for market selection')
    .option('--market-snapshot <path>', 'Saved annual Ozon category analytics snapshot')
    .option('--category-count <n>', 'Market-selection category count from 5 to 10; defaults to 5-8 based on requested count')
    .option('--candidate-limit <n>', 'Maximum candidate products examined')
    .option('--sku-max <n>', 'Maximum Ozon SKUs retained per source product', '3')
    .option('--price-min <n>', 'Minimum 1688 purchase price in CNY')
    .option('--price-max <n>', 'Maximum 1688 purchase price in CNY')
    .option('--headed', 'Use a visible browser')
    .option('--generate-images', 'Use the customer-configured image provider; default is validated 1688 originals')
    .option('--captcha-policy <policy>', 'pause or skip_product', 'skip_product')
    .action(async (opts) => {
      const count = positiveInteger(opts.count, '--count');
      const candidateLimit = opts.candidateLimit ? positiveInteger(opts.candidateLimit, '--candidate-limit') : Math.max(count * 3, count);
      const captchaPolicy = opts.captchaPolicy === 'pause' || opts.captchaPolicy === 'skip_product' ? opts.captchaPolicy : null;
      if (!captchaPolicy) throw new CliError(2, 'BAD_INPUT', '--captcha-policy must be pause or skip_product.');
      emitCommandResult(await createBatchWorkflow({
        batch_id: opts.batchId, store_id: opts.storeId, requested_listing_count: count,
        keyword: opts.keyword, profiles: parseTwoProfiles(opts.profiles), headed: Boolean(opts.headed),
        captcha_policy: captchaPolicy, max_sku_per_product: positiveInteger(opts.skuMax, '--sku-max'),
        price_min_cny: parseOptionalNumber(opts.priceMin), price_max_cny: parseOptionalNumber(opts.priceMax),
        candidate_limit: candidateLimit,
        category_count: opts.categoryCount === undefined ? undefined : positiveInteger(opts.categoryCount, '--category-count'),
        market_snapshot_path: opts.marketSnapshot,
        generate_images: Boolean(opts.generateImages),
      }));
    });
  batch.command('status').description('Read a saved batch without starting collection or publishing')
    .requiredOption('--batch-id <id>', 'Batch ID to inspect')
    .action(async (opts) => { emitCommandResult(await getBatchWorkflowStatus(opts.batchId)); });
  batch.command('agent-tasks').description('Read paused current-Agent tasks and their binding hashes')
    .requiredOption('--batch-id <id>', 'Batch ID to inspect')
    .action(async (opts) => {
      emitCommandResult({
        ok: true,
        command: 'workflow.batch.agent-tasks',
        data: await getBatchDecisionTasks(opts.batchId),
        warnings: [],
        errors: [],
        nextActions: [],
      });
    });
  for (const commandName of ['run', 'resume'] as const) {
    batch.command(commandName).description(commandName === 'run' ? 'Run the foreground batch until completion or an Agent decision is required' : 'Resume paused product runs without creating a new batch')
      .requiredOption('--batch-id <id>', 'Batch ID')
      .action(async (opts) => { emitCommandResult(await runBatchWorkflow({ batch_id: opts.batchId })); });
  }
  batch.command('agent-input').description('Validate and save an AgentDecisionEnvelopeV1 into a fixed batch handoff slot')
    .requiredOption('--batch-id <id>', 'Batch ID')
    .requiredOption('--offer-id <id>', '1688 offer ID')
    .requiredOption('--kind <kind>', 'category, pricing, attributes, or images')
    .option('--value <json>', 'Decision JSON')
    .option('--stdin', 'Read decision JSON from stdin')
    .action(async (opts) => {
      const kind = ['category', 'pricing', 'attributes', 'images'].includes(opts.kind) ? opts.kind as 'category' | 'pricing' | 'attributes' | 'images' : null;
      if (!kind) throw new CliError(2, 'BAD_INPUT', '--kind must be category, pricing, attributes, or images.');
      if (Boolean(opts.stdin) === Boolean(opts.value)) throw new CliError(2, 'BAD_INPUT', 'Use exactly one of --value or --stdin.');
      const raw = opts.stdin ? await readStdinText() : opts.value;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new CliError(2, 'BAD_INPUT', 'Agent input must be valid JSON.'); }
      emitCommandResult(await submitBatchAgentDecision({ batch_id: opts.batchId, offer_id: opts.offerId, kind, envelope: value }));
    });

  const categoryCmd = workflow
    .command('category')
    .description('Category-related workflows: sourcing → decision → attributes');

  categoryCmd
    .command('refresh-tree')
    .description('Refresh the versioned Chinese Ozon category tree through the fixed read-only Seller endpoint')
    .requiredOption('--store-id <Client-Id>', 'Local StoreProfileV2 used only to authenticate the read')
    .action(async (opts) => {
      emitCommandResult(await refreshOzonCategoryTree({ store_id: opts.storeId }));
    });

  categoryCmd
    .command('inspect')
    .description('Source 1688 product → load CategoryDecision → fetch Ozon attributes')
    .argument('<keyword>', 'Search keyword for 1688 sourcing')
    .option('--max <n>', 'Maximum products to source', '1')
    .option('--sku-max <n>', 'Keep only products with at most n normalized SKUs')
    .option('--price-min <n>', 'Minimum actual 1688 SKU purchase price in CNY')
    .option('--price-max <n>', 'Maximum actual 1688 SKU purchase price in CNY')
    .option('--decision-file <path>', 'Path to CategoryDecisionV1 JSON file')
    .requiredOption('--store-id <Client-Id>', 'Local StoreProfileV2 used only to authenticate the read')
    .option('--products-dir <directory>', 'Product workspace root', 'data/products')
    .action(async (keyword, opts) => {
      emitCommandResult(
        await runCategoryInspect({
          keyword,
          max: parseNumber(opts.max) ?? 1,
          skuMax: parseSkuMax(opts.skuMax),
          decisionFile: opts.decisionFile,
          storeId: opts.storeId,
          productsDir: opts.productsDir,
        }),
      );
    });

  const listing = workflow
    .command('listing')
    .description('Listing preparation workflows');

  listing
    .command('prepare')
    .description('Run or resume source → canonical → category → pricing → attributes → mapping')
    .argument('<keyword>', '1688 keyword used when the source step must run')
    .option('--run-id <id>', 'Reuse a run ID to resume from saved artifacts')
    .option('--store-id <Client-Id>', 'Store profile used for read-only Ozon category/attribute calls')
    .option('--decision-file <path>', 'Path to CategoryDecisionV1 JSON')
    .option('--attribute-agent-json <json>', 'Agent-selected attribute values as AttributeMappingAgentInputV1 JSON')
    .option('--attribute-agent-stdin', 'Read AttributeMappingAgentInputV1 JSON from stdin')
    .option('--pricing-agent-json <json>', 'Agent-estimated package values as CostPricingAgentInputV1 JSON')
    .option('--pricing-agent-stdin', 'Read CostPricingAgentInputV1 JSON from stdin')
    .option('--image-review-json <json>', 'Current-Agent image text/watermark review as ImageReviewAgentInputV1 JSON')
    .option('--image-review-stdin', 'Read ImageReviewAgentInputV1 JSON from stdin')
    .option('--pricing-profile-json <json>', 'CostPricingProfileV1 overrides as JSON')
    .option('--commission-file <path>', 'Ozon category commission snapshot JSON')
    .option('--start-from <step>', 'First step to execute', 'source-1688')
    .option('--stop-after <step>', 'Last step to execute', 'draft-generation')
    .option('--force-step <steps...>', 'Refresh this step and all downstream steps')
    .option('--continue-on-review', 'Continue when an upstream step needs review')
    .option('--sku-max <n>', 'Keep only products with at most n normalized SKUs')
    .option('--price-min <n>', 'Minimum accepted 1688 SKU purchase price in CNY')
    .option('--price-max <n>', 'Maximum accepted 1688 SKU purchase price in CNY')
    .option('--profile <name>', '1688 profile name')
    .option('--headed', 'Open a browser window for manual verification')
    .option('--generate-images', 'Use data/config/image-generation.local.json and its referenced local secret')
    .action(async (keyword, opts) => {
      if ([opts.attributeAgentStdin, opts.pricingAgentStdin, opts.imageReviewStdin].filter(Boolean).length > 1) {
        throw new CliError(2, 'BAD_AGENT_INPUT', 'Only one Agent input may read from stdin per invocation.');
      }
      const attributeAgentInput = await resolveAttributeAgentInput(
        opts.attributeAgentJson,
        Boolean(opts.attributeAgentStdin),
      );
      const pricingAgentInput = await resolvePricingAgentInput(
        opts.pricingAgentJson,
        Boolean(opts.pricingAgentStdin),
      );
      const imageReviewAgentInput = await resolveImageReviewAgentInput(
        opts.imageReviewJson,
        Boolean(opts.imageReviewStdin),
      );
      const pricingProfile = parsePricingProfile(opts.pricingProfileJson);
      const commissionText = opts.commissionFile
        ? await fs.readFile(path.resolve(opts.commissionFile), 'utf8')
        : undefined;
      const commissionSnapshot = commissionText === undefined
        ? undefined
        : JSON.parse(commissionText) as unknown;
      const configuredImages = opts.generateImages ? await loadConfiguredImageGeneration() : null;
      emitCommandResult(
        await runListingPreparation({
          run_id: opts.runId,
          store_id: opts.storeId,
          source: {
            mode: 'keyword',
            keyword,
            max: 1,
            skuMax: parseSkuMax(opts.skuMax),
            filters: {
              priceMin: parseOptionalNumber(opts.priceMin),
              priceMax: parseOptionalNumber(opts.priceMax),
            },
            profile: opts.profile,
            headed: opts.headed,
          },
          qualification: {
            max_sku_per_product: parseSkuMax(opts.skuMax) ?? Number.MAX_SAFE_INTEGER,
            price_min_cny: parseOptionalNumber(opts.priceMin),
            price_max_cny: parseOptionalNumber(opts.priceMax),
            require_image: true,
          },
          category_decision_file: opts.decisionFile,
          cost_pricing_profile: pricingProfile,
          cost_pricing_agent_input: pricingAgentInput,
          cost_pricing_commission_snapshot: commissionSnapshot,
          cost_pricing_commission_snapshot_sha256: commissionText === undefined
            ? undefined
            : createHash('sha256').update(commissionText).digest('hex'),
          attribute_mapping_agent_input: attributeAgentInput,
          image_review_agent_input: imageReviewAgentInput,
          image_generation: configuredImages?.options,
          image_generation_provider: configuredImages?.provider,
          start_from: parseWorkflowStep(opts.startFrom),
          stop_after: parseWorkflowStep(opts.stopAfter),
          force_steps: (opts.forceStep ?? []).map(parseWorkflowStep),
          stop_on_review: !opts.continueOnReview,
        }),
      );
    });

  listing.command('publish').description('Submit an existing listing draft to the explicitly selected Ozon store')
    .requiredOption('--run-id <id>', 'Run containing a draft_complete listing draft')
    .requiredOption('--store-id <Client-Id>', 'Seller Client-Id configured in local store profile')
    .action(async (opts) => { emitCommandResult(await runListingPublish({ run_id: opts.runId, store_id: opts.storeId })); });
  listing.command('resume').description('Resume polling or retry failed recoverable SKU imports')
    .requiredOption('--run-id <id>', 'Run to resume')
    .requiredOption('--store-id <Client-Id>', 'Seller Client-Id configured in local store profile')
    .action(async (opts) => { emitCommandResult(await runListingPublish({ run_id: opts.runId, store_id: opts.storeId })); });
  listing.command('status').description('Read the stored listing-submit result without calling Ozon')
    .requiredOption('--run-id <id>', 'Run to inspect')
    .action(async (opts) => { emitCommandResult(await getListingPublishStatus(opts.runId)); });
}

function parsePricingAgentJson(raw: string | undefined): CostPricingAgentInputV1 | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CostPricingAgentInputV1>;
    if (!value || typeof value.source_offer_id !== 'string' || !Array.isArray(value.sku_inputs)) {
      throw new Error('shape');
    }
    return value as CostPricingAgentInputV1;
  } catch {
    throw new CliError(2, 'BAD_PRICING_AGENT_JSON', 'Pricing Agent input must be valid CostPricingAgentInputV1 JSON.');
  }
}

async function resolvePricingAgentInput(
  raw: string | undefined,
  fromStdin: boolean,
): Promise<CostPricingAgentInputV1 | undefined> {
  if (raw !== undefined && fromStdin) {
    throw new CliError(2, 'BAD_PRICING_AGENT_INPUT', 'Use only one of --pricing-agent-json or --pricing-agent-stdin.');
  }
  if (!fromStdin) return parsePricingAgentJson(raw);
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  if (!input.trim()) throw new CliError(2, 'BAD_PRICING_AGENT_INPUT', '--pricing-agent-stdin received no JSON.');
  return parsePricingAgentJson(input.trim());
}

function parsePricingProfile(raw: string | undefined): Partial<CostPricingProfileV1> | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Partial<CostPricingProfileV1>;
  } catch {
    throw new CliError(2, 'BAD_PRICING_PROFILE_JSON', '--pricing-profile-json must be a JSON object.');
  }
}

function parseAttributeAgentJson(raw: string | undefined): AttributeMappingAgentInputV1 | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AttributeMappingAgentInputV1>;
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.source_offer_id !== 'string' ||
      !Array.isArray(value.sku_inputs)
    ) {
      throw new Error('shape');
    }
    return value as AttributeMappingAgentInputV1;
  } catch {
    throw new CliError(
      2,
      'BAD_ATTRIBUTE_AGENT_JSON',
      '--attribute-agent-json must be valid AttributeMappingAgentInputV1 JSON.',
    );
  }
}

async function resolveAttributeAgentInput(
  raw: string | undefined,
  fromStdin: boolean,
): Promise<AttributeMappingAgentInputV1 | undefined> {
  if (raw !== undefined && fromStdin) {
    throw new CliError(
      2,
      'BAD_ATTRIBUTE_AGENT_INPUT',
      'Use only one of --attribute-agent-json or --attribute-agent-stdin.',
    );
  }
  if (!fromStdin) return parseAttributeAgentJson(raw);
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  if (!input.trim()) {
    throw new CliError(2, 'BAD_ATTRIBUTE_AGENT_INPUT', '--attribute-agent-stdin received no JSON.');
  }
  return parseAttributeAgentJson(input.trim());
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

function parseImageReviewAgentJson(raw: string | undefined): ImageReviewAgentInputV1 | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ImageReviewAgentInputV1>;
    if (!value || typeof value.source_offer_id !== 'string' || !Array.isArray(value.assets)) throw new Error('shape');
    for (const asset of value.assets) {
      if (!asset || typeof asset.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.content_sha256)
        || typeof asset.contains_chinese_text !== 'boolean'
        || typeof asset.contains_watermark !== 'boolean'
        || typeof asset.notes !== 'string') throw new Error('shape');
    }
    return value as ImageReviewAgentInputV1;
  } catch {
    throw new CliError(2, 'BAD_IMAGE_REVIEW_JSON', 'Image review must be valid ImageReviewAgentInputV1 JSON.');
  }
}

async function resolveImageReviewAgentInput(raw: string | undefined, fromStdin: boolean): Promise<ImageReviewAgentInputV1 | undefined> {
  if (raw !== undefined && fromStdin) throw new CliError(2, 'BAD_IMAGE_REVIEW_INPUT', 'Use only one of --image-review-json or --image-review-stdin.');
  if (!fromStdin) return parseImageReviewAgentJson(raw);
  const input = await readStdinText();
  if (!input.trim()) throw new CliError(2, 'BAD_IMAGE_REVIEW_INPUT', '--image-review-stdin received no JSON.');
  return parseImageReviewAgentJson(input.trim());
}

function positiveInteger(raw: string | undefined, option: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new CliError(2, 'BAD_INPUT', `${option} must be a positive integer.`);
  return value;
}

function parseTwoProfiles(raw: string): [string, string, ...string[]] {
  const profiles = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (profiles.length < 2 || profiles.some((value) => !/^[A-Za-z0-9_-]{1,64}$/u.test(value))) {
    throw new CliError(2, 'BAD_INPUT', '--profiles requires at least two safe 1688 profile names separated by commas.');
  }
  return profiles as [string, string, ...string[]];
}

async function readStdinText(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  if (!value.trim()) throw new CliError(2, 'BAD_INPUT', 'stdin contained no JSON.');
  return value.trim();
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
    'cost-pricing',
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
