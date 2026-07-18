import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '@auto-ozon/artifact-store';
import type { ListingDraftV2 } from '@auto-ozon/contracts';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

let compiled: ValidateFunction | null = null;

export type ListingDraftArtifactValidation =
  | { ok: true; value: ListingDraftV2; errors: [] }
  | { ok: false; code: 'LEGACY_DRAFT_CONTRACT_UNSUPPORTED' | 'DRAFT_SCHEMA_INVALID'; errors: string[] };

export function validateListingDraftSchema(value: unknown): { valid: boolean; errors: ErrorObject[] } {
  compiled ??= new Ajv2020({ allErrors: true }).compile(JSON.parse(fs.readFileSync(resolveSchemaPath(), 'utf8')) as object);
  const valid = compiled(value);
  return { valid: valid === true, errors: compiled.errors ? [...compiled.errors] : [] };
}

/** Runtime boundary for persisted or externally supplied draft artifacts. */
export function validateListingDraftArtifact(value: unknown): ListingDraftArtifactValidation {
  if (isRecord(value) && value.schema_version === 1) {
    return { ok: false, code: 'LEGACY_DRAFT_CONTRACT_UNSUPPORTED', errors: ['ListingDraftV1 is read-only and cannot be published.'] };
  }
  const validation = validateListingDraftSchema(value);
  if (!validation.valid) {
    return {
      ok: false,
      code: 'DRAFT_SCHEMA_INVALID',
      errors: validation.errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.trim()),
    };
  }
  return { ok: true, value: value as ListingDraftV2, errors: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchemaPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = resolveRepoRoot(moduleDirectory);
  const candidates = [
    path.resolve(moduleDirectory, '../schemas/listing-draft-v2.json'),
    path.join(root, 'packages/artifact-validation/schemas/listing-draft-v2.json'),
  ];
  const found = candidates.find(fs.existsSync);
  if (!found) throw new Error(`ListingDraftV2 schema not found: ${candidates.join(', ')}`);
  return found;
}
