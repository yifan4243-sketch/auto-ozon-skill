import type { CommandResult, SourcingResult, SourcingResultV2 } from '@auto-ozon/contracts';
import {
  runSource1688,
  type RunSource1688Input,
} from '@auto-ozon/step-source-1688';
import { runCanonicalizeProduct } from '@auto-ozon/step-canonicalize-product';

export interface RunSourceCommandInput {
  source: RunSource1688Input;
  schema_version: 1 | 2;
  products_dir?: string;
}

export async function runSourceCommand(
  input: RunSourceCommandInput,
): Promise<CommandResult<SourcingResult | SourcingResultV2>> {
  const source = await runSource1688(input.source);
  if (!source.data) {
    return {
      ok: false,
      command: source.command,
      warnings: source.warnings,
      errors: source.errors,
      nextActions: source.nextActions,
    };
  }
  return runCanonicalizeProduct({
    source: source.data,
    schema_version: input.schema_version,
    command: source.command,
    products_dir: input.products_dir,
    discovery_context: {
      searchTerm: input.source.mode === 'keyword' ? input.source.keyword : null,
      seedOfferId: input.source.mode === 'similar' ? input.source.offerId : null,
    },
  });
}

export interface RunOfflineNormalizeCommandInput {
  input_path: string;
  method: 'keyword' | 'image' | 'offers' | 'similar';
  search_term?: string | null;
  seed_offer_id?: string | null;
  products_dir?: string;
}

export function runOfflineNormalizeCommand(
  input: RunOfflineNormalizeCommandInput,
): Promise<CommandResult<SourcingResult | SourcingResultV2>> {
  return runCanonicalizeProduct({
    schema_version: 2,
    command: 'source.normalize-v2',
    offline: {
      inputPath: input.input_path,
      method: input.method,
      searchTerm: input.search_term,
      seedOfferId: input.seed_offer_id,
      productsDir: input.products_dir,
    },
    discovery_context: {
      searchTerm: input.search_term,
      seedOfferId: input.seed_offer_id,
    },
  });
}
