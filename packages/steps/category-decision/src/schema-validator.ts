import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

export interface CategoryDecisionSchemaValidation {
  valid: boolean;
  errors: ErrorObject[];
}

let compiledSchema: ValidateFunction | null = null;

export function validateCategoryDecisionSchema(
  value: unknown,
): CategoryDecisionSchemaValidation {
  compiledSchema ??= compileCategoryDecisionSchema();
  const valid = compiledSchema(value);
  return {
    valid: valid === true,
    errors: compiledSchema.errors ? [...compiledSchema.errors] : [],
  };
}

export function resolveCategoryDecisionSchemaPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveRepoRoot(moduleDir);
  const candidates = [
    path.join(repoRoot, 'packages/steps/category-decision/output.schema.json'),
    path.resolve(moduleDir, '../output.schema.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `CategoryDecisionV1 schema not found. Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}

function compileCategoryDecisionSchema(): ValidateFunction {
  const schema = JSON.parse(
    fs.readFileSync(resolveCategoryDecisionSchemaPath(), 'utf8'),
  ) as object;
  return new Ajv2020({ allErrors: true }).compile(schema);
}
