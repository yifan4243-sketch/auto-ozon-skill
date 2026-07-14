# Attribute mapping policy

Apply values in this order:

1. exact retained product or SKU fact;
2. deterministic unit conversion or formula;
3. validated Agent selection from the current category dictionary;
4. an explicit policy default that exists in the current dictionary.

Never overwrite a deterministic source match with Agent input. Match generic
source facts only when the normalized source field name equals the Ozon
attribute name. For dictionary attributes, require an exact normalized value or
a supplied dictionary ID whose ID and text both match the snapshot.

An attribute is common only when every SKU in its category group has identical
values. If values differ or a SKU lacks the value, classify it as a variant
attribute and retain `values_by_sku`. Every SKU still receives its complete
mapped attribute array in `sku_attributes`.

Required attributes without values populate both `missing_required_attributes`
and `unresolved_attributes`, and block the result. Optional attributes without
evidence may be omitted. Low-confidence mapped values produce `needs_review`.

Russian name (4180), description (4191), and hashtags (23171) are intentionally
deferred to `draft-generation`. They are not missing factual mappings and must
not block `AttributeMappingV1`.
Packaging weight is source evidence, not net weight. Map attribute 4497 from
`skus[].package.raw_weight` only when its unit is known. Never add a packaging
allowance, and never map the same value to net-weight attribute 4383 unless the
source explicitly labels it as net weight.
