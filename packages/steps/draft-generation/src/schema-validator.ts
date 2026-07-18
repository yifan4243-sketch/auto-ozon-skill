import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

let compiled: ValidateFunction | null = null;
export function validateListingDraftSchema(value: unknown): { valid: boolean; errors: ErrorObject[] } {
  compiled ??= new Ajv2020({ allErrors: true }).compile(JSON.parse(fs.readFileSync(resolveSchemaPath(), 'utf8')) as object);
  const valid = compiled(value);
  return { valid: valid === true, errors: compiled.errors ? [...compiled.errors] : [] };
}
function resolveSchemaPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = resolveRepoRoot(moduleDirectory);
  const candidates = [path.join(root, 'packages/steps/draft-generation/output.schema.json'), path.resolve(moduleDirectory, '../output.schema.json')];
  const found = candidates.find(fs.existsSync);
  if (!found) throw new Error(`ListingDraftV2 schema not found: ${candidates.join(', ')}`);
  return found;
}
