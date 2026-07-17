import fs from 'node:fs/promises';
import path from 'node:path';
import type { ListingBatchResultV1, ListingJobSpecV1, MarketSelectionV1 } from '@auto-ozon/contracts';

export class FileBatchStore {
  constructor(readonly root = path.resolve('data/batches')) {}

  async create(spec: ListingJobSpecV1): Promise<ListingBatchResultV1> {
    validateBatchId(spec.batch_id);
    const directory = this.directory(spec.batch_id);
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.mkdir(directory, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('BATCH_ALREADY_EXISTS');
      throw error;
    }
    await atomicJson(path.join(directory, 'job-spec-v1.json'), spec);
    const result: ListingBatchResultV1 = {
      schema_version: 1, batch_id: spec.batch_id, status: 'created',
      requested_listing_count: spec.requested_listing_count, candidate_count: 0,
      succeeded_count: 0, failed_count: 0, skipped_count: 0, product_runs: [],
      created_at: spec.created_at, updated_at: spec.created_at,
    };
    await atomicJson(path.join(directory, 'batch-result-v1.json'), result);
    return result;
  }

  async readSpec(batchId: string): Promise<ListingJobSpecV1> {
    return readJson<ListingJobSpecV1>(path.join(this.directory(batchId), 'job-spec-v1.json'));
  }

  async readResult(batchId: string): Promise<ListingBatchResultV1> {
    return readJson<ListingBatchResultV1>(path.join(this.directory(batchId), 'batch-result-v1.json'));
  }

  async writeResult(result: ListingBatchResultV1): Promise<void> {
    await atomicJson(path.join(this.directory(result.batch_id), 'batch-result-v1.json'), result);
  }

  async writeMarketSelection(batchId: string, selection: MarketSelectionV1): Promise<void> {
    await atomicJson(path.join(this.directory(batchId), 'market-selection-v1.json'), selection);
  }

  async readMarketSelection(batchId: string): Promise<MarketSelectionV1 | null> {
    try { return await readJson<MarketSelectionV1>(path.join(this.directory(batchId), 'market-selection-v1.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  private directory(batchId: string): string {
    validateBatchId(batchId);
    const directory = path.resolve(this.root, batchId);
    const relative = path.relative(path.resolve(this.root), directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('BATCH_PATH_INVALID');
    return directory;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

function validateBatchId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new Error('BATCH_ID_INVALID');
}
