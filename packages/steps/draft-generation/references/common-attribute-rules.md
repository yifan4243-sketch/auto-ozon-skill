# Common Ozon Attribute Rules V0

Use the current category's `CategoryAttributesV1` as the authority for whether
an attribute exists, whether it is required, and which dictionary values are
valid. A fixed dictionary ID below is a default candidate, not permission to
bypass the snapshot.

| ID | Rule |
|---:|---|
| 85 | Use a verified source brand only when its current dictionary value is known. Otherwise use `126745801` (no brand). Omit the no-brand phrase from the generated name. |
| 4180 | Generate one Russian name per SKU and copy the exact value to the draft item's top-level `name`. |
| 4191 | Generate a Russian factual description from retained 1688 facts only. |
| 4383 | Fill net product weight in grams. The mapper keeps CanonicalProductV2 grams, converts its kilograms, and otherwise uses a positive Agent gram estimate marked `agent_estimated`. |
| 4389 | Use a verified source country when its current dictionary value is known. Otherwise use `90296` (China). |
| 4497 | Derive packaged weight as `4383 + 50` grams. Never ask the Agent to choose it independently. |
| 8229 | Always select one valid current dictionary value. A low-confidence closest match is allowed only with `needs_review`; never invent an ID. |
| 8789 | Leave blank. |
| 9024 | Leave blank in V0. This is a seller product code, not a shop Client ID or API key. |
| 9048 | For single-SKU and normal variants, use the 1688 offer ID. For mixed products, use `<offer_id>-<group_id>`. |
| 10096 | Select one or more current color values from SKU facts and images. If no color is defensible, use `369939085` (multicolor). |
| 11254 | Leave blank. |
| 11650 | Use the source factory-package count when defensible; otherwise use integer `1`. |
| 23171 | Generate 20 to 30 Russian hashtags under the copy rules. |
| 23249 | Fill a positive integer only when pieces per SKU are defensible. Otherwise omit it. |

Do not emit attributes outside this table. If the current category marks an
outside attribute as required, return `blocked` with
`UNSUPPORTED_REQUIRED_ATTRIBUTE` instead of creating an upload-invalid draft.

For attributes 8789, 9024, and 11254, a future required flag also blocks the
draft because the V0 policy explicitly leaves them blank.
