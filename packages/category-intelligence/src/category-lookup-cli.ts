import { parseArgs } from 'node:util';
import {
  getOzonCategoryTreeStats,
  loadOzonCategoryIndex,
  loadOzonCategoryTree,
  searchOzonCategories,
  validateOzonCategoryPair,
} from './ozon-category-tree.js';

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    tree: { type: 'string' },
    limit: { type: 'string', default: '20' },
    'description-category-id': { type: 'string' },
    'type-id': { type: 'string' },
  },
});

if (command === 'stats') {
  const tree = await loadOzonCategoryTree(values.tree);
  emit(getOzonCategoryTreeStats(tree));
} else if (command === 'search') {
  const query = positionals.join(' ').trim();
  if (!query) fail('search requires a query');
  const limit = Number.parseInt(values.limit ?? '20', 10);
  if (!Number.isInteger(limit) || limit <= 0) fail('--limit must be a positive integer');
  const index = await loadOzonCategoryIndex(values.tree);
  const candidates = searchOzonCategories(index, query, limit);
  emit({ query, total: candidates.length, candidates });
} else if (command === 'validate') {
  const descriptionCategoryId = Number(values['description-category-id']);
  const typeId = Number(values['type-id']);
  if (!Number.isInteger(descriptionCategoryId) || !Number.isInteger(typeId)) {
    fail('validate requires integer --description-category-id and --type-id');
  }
  const index = await loadOzonCategoryIndex(values.tree);
  const result = validateOzonCategoryPair(index, descriptionCategoryId, typeId);
  emit(result);
  if (!result.valid) process.exitCode = 2;
} else {
  fail('usage: category:lookup <stats|search|validate> [options]');
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
