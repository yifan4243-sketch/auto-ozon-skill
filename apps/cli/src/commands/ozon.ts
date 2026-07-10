import type { Command } from 'commander';
import type { CommandResult } from '../../../../packages/contracts/src/command-result.js';
import {
  ozonCallMethod,
  ozonDescribeMethod,
  ozonDoctor,
  ozonFetchAll,
  ozonGetErrorCatalog,
  ozonGetExamples,
  ozonGetRateLimits,
  ozonGetRelatedMethods,
  ozonGetSection,
  ozonGetSubscriptionStatus,
  ozonGetSwaggerMeta,
  ozonGetWorkflow,
  ozonListMethodsForSubscription,
  ozonListSections,
  ozonListWorkflows,
  ozonSearchMethods,
} from '../../../../packages/adapters-ozon/src/client.js';

type EmitCommandResult = (result: CommandResult<unknown>) => void;
type ParseNumber = (raw: string | undefined) => number | undefined;
type ParseJsonParams = (
  raw: string | undefined,
  command: string,
) =>
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: CommandResult<unknown> };

export function registerOzonCommands(
  program: Command,
  emitCommandResult: EmitCommandResult,
  parseJsonParams: ParseJsonParams,
  parseNumber: ParseNumber,
): void {
  const ozon = program
    .command('ozon')
    .description('Complete PCDCK/ozon-mcp bridge with local read-only execution safety');

  ozon
    .command('doctor')
    .description('Check vendor/ozon-mcp, uv, all bridge tools, and credentials')
    .action(async () => {
      emitCommandResult(await ozonDoctor());
    });

  const sections = ozon.command('sections').description('Browse Ozon API sections');
  sections
    .command('list')
    .description('List all Seller and Performance API sections')
    .action(async () => {
      emitCommandResult(await ozonListSections());
    });
  sections
    .command('get')
    .description('List methods in one API section')
    .argument('<query>', 'Section name or tag')
    .action(async (query) => {
      emitCommandResult(await ozonGetSection({ query }));
    });

  const methods = ozon.command('methods').description('Discover and inspect Ozon API methods');
  methods
    .command('search')
    .description('Full-text search across Ozon API methods')
    .argument('<query>', 'Search query')
    .option('--section <section>', 'Filter by section name or tag')
    .option('--api <api>', 'Filter by API: seller | performance')
    .option('--safety <safety>', 'Filter by safety: read | write | destructive')
    .option('--limit <n>', 'Maximum number of methods', '10')
    .action(async (query, opts) => {
      emitCommandResult(
        await ozonSearchMethods({
          query,
          section: opts.section,
          api: opts.api,
          safety: opts.safety,
          limit: parseNumber(opts.limit),
        }),
      );
    });
  methods
    .command('describe')
    .description('Describe one Ozon API method by operationId or path')
    .argument('[operationId]', 'Ozon operationId')
    .option('--path <path>', 'Ozon endpoint path')
    .option('--http-method <method>', 'HTTP method when path is ambiguous')
    .action(async (operationId, opts) => {
      emitCommandResult(
        await ozonDescribeMethod({
          operationId,
          path: opts.path,
          httpMethod: opts.httpMethod,
        }),
      );
    });
  methods
    .command('related')
    .description('Find methods related to one operation')
    .argument('<operationId>', 'Ozon operationId')
    .option('--max-hops <n>', 'Relationship graph depth', '1')
    .action(async (operationId, opts) => {
      emitCommandResult(
        await ozonGetRelatedMethods({
          operationId,
          maxHops: parseNumber(opts.maxHops),
        }),
      );
    });
  methods
    .command('examples')
    .description('Get validated request examples for one method')
    .argument('<operationId>', 'Ozon operationId')
    .action(async (operationId) => {
      emitCommandResult(await ozonGetExamples({ operationId }));
    });

  const reference = ozon
    .command('reference')
    .description('Inspect limits, errors, and bundled Swagger metadata');
  reference
    .command('rate-limits')
    .description('Get rate limits for a method, section, or all known endpoints')
    .option('--operation-id <operationId>', 'Filter by operationId')
    .option('--section <section>', 'Filter by section')
    .action(async (opts) => {
      emitCommandResult(
        await ozonGetRateLimits({
          operationId: opts.operationId,
          section: opts.section,
        }),
      );
    });
  reference
    .command('errors')
    .description('Get Ozon error catalog entries')
    .option('--code <code>', 'Filter by error code')
    .option('--operation-id <operationId>', 'Include method-specific errors')
    .action(async (opts) => {
      emitCommandResult(
        await ozonGetErrorCatalog({
          code: opts.code,
          operationId: opts.operationId,
        }),
      );
    });
  reference
    .command('swagger-meta')
    .description('Show bundled Ozon Swagger snapshot metadata')
    .action(async () => {
      emitCommandResult(await ozonGetSwaggerMeta());
    });

  const subscription = ozon
    .command('subscription')
    .description('Inspect Ozon subscription tier and gated methods');
  subscription
    .command('status')
    .description('Read current cabinet subscription status')
    .option('--refresh', 'Bypass the MCP process cache')
    .action(async (opts) => {
      emitCommandResult(await ozonGetSubscriptionStatus({ refresh: opts.refresh }));
    });
  subscription
    .command('methods')
    .description('List methods mentioning one subscription tier')
    .argument('<tier>', 'UNSPECIFIED | PREMIUM_LITE | PREMIUM | PREMIUM_PLUS | PREMIUM_PRO')
    .action(async (tier) => {
      emitCommandResult(await ozonListMethodsForSubscription({ tier }));
    });

  ozon
    .command('call')
    .description('Call a read-only Ozon method through PCDCK/ozon-mcp')
    .argument('<operationId>', 'Ozon operationId')
    .option('--params <json>', 'JSON params object', '{}')
    .option('--cabinet-tier <tier>', 'Optional subscription tier override')
    .action(async (operationId, opts) => {
      const params = parseJsonParams(opts.params, 'ozon.call');
      if (!params.ok) {
        emitCommandResult(params.result);
        return;
      }
      emitCommandResult(
        await ozonCallMethod({
          operationId,
          params: params.value,
          cabinetTier: opts.cabinetTier,
        }),
      );
    });

  ozon
    .command('fetch-all')
    .description('Fetch all pages for a read-only paginated Ozon method')
    .argument('<operationId>', 'Ozon operationId')
    .option('--params <json>', 'JSON params object', '{}')
    .option('--max-items <n>', 'Maximum items to fetch', '10000')
    .option('--cabinet-tier <tier>', 'Optional subscription tier override')
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
          cabinetTier: opts.cabinetTier,
        }),
      );
    });

  const workflows = ozon
    .command('workflows')
    .description('List and inspect curated PCDCK Ozon MCP workflows');
  workflows
    .command('list')
    .description('List Ozon MCP workflows')
    .option('--category <category>', 'Filter by workflow category')
    .action(async (opts) => {
      emitCommandResult(await ozonListWorkflows({ category: opts.category }));
    });
  workflows
    .command('get')
    .description('Get one Ozon MCP workflow')
    .argument('<name>', 'Workflow name')
    .action(async (name) => {
      emitCommandResult(await ozonGetWorkflow({ name }));
    });
}
