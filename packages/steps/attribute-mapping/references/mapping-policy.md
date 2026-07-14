# Attribute mapping policy

Only process the explicitly owned attributes below plus any additional Ozon
required attribute. Omit every other optional attribute.

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
- 4383: use explicit 1688 weight plus unit; convert kg to g; values <=3g are
  missing and go to the Agent.
- 4389: fixed China dictionary value ID 90296.
- 9048: the run creation time in Asia/Shanghai as `YYYYMMDDHHmmss`, stable for
  every SKU and rerun in that run.
- 11650 and 23249: fixed value `1`.
- Never derive 4497 from net weight.

Agent-owned attributes:

- 4180: Russian category + product name + variant attributes; omit all brands.
- 4191: factual Russian description, at least four paragraphs and 500
  non-whitespace characters.
- 4383 only when script weight is missing: estimate grams, value >3, low
  confidence, automatically accepted.
- 8229: always select the best current dictionary value.
- 10096: select current color values; when facts cannot decide, choose the
  current dictionary candidate meaning multicolor.
- 23171: exactly 20 unique Russian hashtags separated by one space.
- Any additional Ozon-required attribute goes to the Agent. Dictionary values
  must come from the snapshot; non-dictionary values require canonical evidence.

The final artifact contains provenance-rich mappings and an ID-sorted
`ozon_attributes` array for every SKU. It is not a complete product import
payload.
