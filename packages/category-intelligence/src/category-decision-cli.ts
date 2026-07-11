import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type {
  CanonicalProductV2,
  CategoryDecisionV1,
} from '../../contracts/src/index.js';
import { validateCategoryDecisionSchema } from './category-decision-schema.js';
import { validateCategoryDecision } from './category-decision-validator.js';
import { loadOzonCategoryIndex } from './ozon-category-tree.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    product: { type: 'string' },
    decision: { type: 'string' },
    tree: { type: 'string' },
  },
});

if (command !== 'validate') {
  fail(
    'usage: category:decision validate --product <canonical-v2.json> --decision <decision.json>',
  );
}
if (!values.product || !values.decision) {
  fail('validate requires --product and --decision');
}

const product = JSON.parse(
  await fs.readFile(resolveInputPath(values.product), 'utf8'),
) as CanonicalProductV2;
const decisionValue = JSON.parse(
  await fs.readFile(resolveInputPath(values.decision), 'utf8'),
) as unknown;
const schema = validateCategoryDecisionSchema(decisionValue);
if (!schema.valid) {
  emit({
    status: 'fail',
    valid: false,
    schema_errors: schema.errors,
    violations: [],
  });
  process.exit(2);
}

const categories = await loadOzonCategoryIndex(values.tree);
const result = validateCategoryDecision(
  decisionValue as CategoryDecisionV1,
  product,
  categories,
);
emit({ ...result, schema_errors: [] });
if (!result.valid) process.exitCode = 2;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function resolveInputPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const candidates = [
    path.resolve(process.cwd(), value),
    path.resolve(process.cwd(), '../..', value),
  ];
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) fail(`input file not found: ${value}`);
  return found;
}
