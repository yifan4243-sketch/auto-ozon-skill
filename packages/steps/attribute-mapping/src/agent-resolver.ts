import type {
  AttributeMappingAgentInputV1,
  CategoryAttributeV1,
  MappedOzonAttributeV1,
} from '@auto-ozon/contracts';
import { validateDictionaryValues } from './dictionary-resolver.js';

export interface AgentResolutionV1 {
  attribute: MappedOzonAttributeV1 | null;
  error: 'dictionary_value_not_found' | null;
}

export function resolveAgentAttribute(
  agentInput: AttributeMappingAgentInputV1 | undefined,
  sourceSkuId: string,
  attribute: CategoryAttributeV1,
): AgentResolutionV1 {
  const sku = agentInput?.sku_inputs.find((candidate) => candidate.source_sku_id === sourceSkuId);
  const selected = sku?.attributes.find((candidate) => candidate.attribute_id === attribute.id);
  if (!selected) return { attribute: null, error: null };
  if (!validateDictionaryValues(attribute, selected.values)) {
    return { attribute: null, error: 'dictionary_value_not_found' };
  }
  return {
    attribute: {
      attribute_id: attribute.id,
      values: selected.values,
      provenance: 'agent_selected',
      confidence: selected.confidence,
      evidence: selected.evidence,
    },
    error: null,
  };
}
