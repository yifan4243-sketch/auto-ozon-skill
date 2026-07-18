import type { AttributeMappingV2, ContentBundleV1, MappedOzonAttributeV2 } from '@auto-ozon/contracts';

export function buildContentBundle(mapping: AttributeMappingV2): ContentBundleV1 {
  const result: ContentBundleV1 = { schema_version: 1, source_offer_id: mapping.source_offer_id, status: 'completed', sku_content: [], errors: [] };
  for (const sku of mapping.sku_attributes) {
    const title = attribute(sku.attributes, 4180);
    const description = attribute(sku.attributes, 4191);
    const tags = attribute(sku.attributes, 23171);
    if (!title || !description || !tags) {
      result.errors.push({ code: 'CONTENT_FIELDS_MISSING', source_sku_id: sku.source_sku_id, message: 'Attributes 4180, 4191 and 23171 are required.' });
      continue;
    }
    const evidence = [...title.evidence, ...description.evidence, ...tags.evidence]
      .filter((item) => item.source === 'canonical_v2')
      .map((item) => ({ json_pointer: evidencePointer(item.field), value: item.value }));
    const item = {
      source_sku_id: sku.source_sku_id,
      title_ru: title.values.map((value) => value.value).join(' '),
      description_ru: description.values.map((value) => value.value).join('\n'),
      hashtags_ru: tags.values[0]!.value.trim().split(/\s+/u),
      confidence: [title.confidence, description.confidence, tags.confidence].includes('low') ? 'low' : 'medium',
      evidence_refs: uniqueEvidence(evidence),
      claims: (description.content_claims ?? []).map((claim) => ({
        claim_text: claim.claim_text,
        evidence_refs: uniqueEvidence(claim.evidence.map((item) => ({
          json_pointer: evidencePointer(item.field),
          value: item.value,
        }))),
      })),
    } as const;
    const validationErrors = validateContent(item);
    for (const message of validationErrors) {
      result.errors.push({ code: 'CONTENT_INVALID', source_sku_id: sku.source_sku_id, message });
    }
    if (validationErrors.length === 0) result.sku_content.push(item);
  }
  if (result.errors.length > 0 || result.sku_content.length !== mapping.sku_attributes.length) {
    const pendingContentTask = mapping.agent_tasks.some((task) => [4180, 4191, 23171].includes(task.attribute_id));
    result.status = pendingContentTask ? 'needs_review' : 'blocked';
  }
  return result;
}

function attribute(attributes: MappedOzonAttributeV2[], id: number): MappedOzonAttributeV2 | null {
  return attributes.find((item) => item.attribute_id === id) ?? null;
}
function evidencePointer(field: string): string {
  return `/canonical_v2/${field.split('.').map((part) => part.replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/')}`;
}
function uniqueEvidence(values: Array<{ json_pointer: string; value: string }>) {
  return values.filter((item, index) => values.findIndex((candidate) => candidate.json_pointer === item.json_pointer && candidate.value === item.value) === index);
}

function validateContent(item: {
  title_ru: string;
  description_ru: string;
  hashtags_ru: readonly string[];
  evidence_refs: readonly { json_pointer: string; value: string }[];
  claims: readonly { claim_text: string; evidence_refs: readonly { json_pointer: string; value: string }[] }[];
}): string[] {
  const errors: string[] = [];
  if (!/[А-Яа-яЁё]/u.test(item.title_ru) || /нет\s+бренда|без\s+бренда|no\s*name/iu.test(item.title_ru)) {
    errors.push('Russian title is missing or contains the policy no-brand phrase.');
  }
  const paragraphs = item.description_ru.split(/\n\s*\n/u).map((value) => value.trim()).filter(Boolean);
  if (item.description_ru.trim().length < 500 || paragraphs.length < 4) {
    errors.push('Russian description must contain at least four paragraphs and 500 trimmed characters.');
  }
  if (item.hashtags_ru.length !== 20 || new Set(item.hashtags_ru).size !== 20
    || item.hashtags_ru.some((tag) => !/^#[А-Яа-яЁёA-Za-z0-9_]+$/u.test(tag))) {
    errors.push('Hashtags must contain exactly 20 unique #tags separated upstream.');
  }
  if (item.evidence_refs.length === 0 || item.evidence_refs.some((reference) => !reference.json_pointer.startsWith('/canonical_v2/'))) {
    errors.push('Content must cite at least one retained CanonicalProductV2 fact.');
  }
  if (item.claims.length !== paragraphs.length || item.claims.some((claim, index) =>
    claim.claim_text.trim() !== paragraphs[index]
    || claim.evidence_refs.length === 0
    || claim.evidence_refs.some((reference) => !reference.json_pointer.startsWith('/canonical_v2/'))
  )) {
    errors.push('Every Russian description paragraph must be bound to retained CanonicalProductV2 evidence.');
  }
  return errors;
}
