# Attribute mapping policy

Process every attribute returned in the current Ozon category snapshot. Fill an
optional attribute only when retained 1688 facts, a deterministic rule, or a
validated selection from its current dictionary supports it. Omit optional
attributes with no such evidence.

Apply values in this order:

1. exact retained product or SKU fact;
2. deterministic unit conversion or formula;
3. locked script defaults;
4. validated Agent selection.

Never overwrite a deterministic source match with Agent input. Match generic
source facts only when the normalized source field name equals the Ozon
attribute name. For dictionary attributes, require an exact normalized value or
a supplied dictionary ID whose ID and text both match the snapshot.

An attribute is common only when every SKU in its category group has identical
values. If values differ or a SKU lacks the value, classify it as a variant
attribute and retain `values_by_sku`. Every SKU still receives its complete
mapped attribute array in `sku_attributes`.

Required attributes and owned Agent attributes without values populate both `missing_required_attributes`
and `unresolved_attributes`, and block the result. Optional attributes without
evidence may be omitted. Low-confidence mapped values produce `needs_review`.

Script-owned attributes:

- 85: fixed `Нет бренда` / no-brand dictionary value ID 126745801. Never fetch
  the brand dictionary at runtime.
- 4383: use the exact single-SKU `actual_weight_g` used by the completed
  `cost-pricing` step. If that record is unavailable, use explicit 1688 weight
  plus unit; values <=3g are missing and go to the Agent.
- 4497: when 4383 is available, fill `4383 + 50g`.
- 4389: fixed China dictionary value ID 90296.
- 9048: the run creation time in Asia/Shanghai as `YYYYMMDDHHmmss`, stable for
  every SKU and rerun in that run.
- 11650 and 23249: fixed value `1`.

Agent-owned attributes:

- 4180: one natural Russian product-name string; omit all brands and no-brand
  phrases. It may include supported use cases, but is never split into fields.
- 4191: factual Russian description, at least four paragraphs and 500
  non-whitespace characters. Translate retained source facts into Russian.
  Chinese, Japanese, and Korean characters are forbidden in the description;
  raw source-language values remain only in evidence and audit fields.
- 4383 only when script weight is missing: estimate grams, value >3, low
  confidence, automatically accepted.
- 8229: always select the best current dictionary value.
- 10096: select current color values; when facts cannot decide, choose the
  current dictionary candidate meaning multicolor.
- 23171: exactly 20 unique Russian hashtags separated by one space.
- Any unresolved attribute, including optional attributes, is offered to the
  Agent once. Dictionary values must come from the snapshot; non-dictionary
  values require canonical evidence. The Agent omits facts it cannot support.

The final artifact contains provenance-rich mappings and an ID-sorted
`ozon_attributes` array for every SKU. It is not a complete product import
payload.
