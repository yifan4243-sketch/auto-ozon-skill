# Russian Copy Rules V0

Use `1688_data/source.json` and `1688_data_v2/product.json` as the factual
boundary. Do not use supplier identity, sales, stock, purchase price, unsupported
certifications, or imagined performance claims.

## Name — attribute 4180

- Write in Russian using: product type/category + verified brand when present +
  product name/model + SKU variant attributes.
- Omit the brand segment for no-brand products.
- Keep at most 200 characters.
- Remove duplicate words, all-capital wording, trailing punctuation, and facts
  not supported by the source product or SKU.

## Description — attribute 4191

- Write Russian paragraphs covering only supported functions, material,
  dimensions/specifications, use cases, and package contents.
- Make the description detailed by organizing available facts, not by inventing
  missing facts.
- Keep variant-specific claims aligned with the current SKU.

## Hashtags — attribute 23171

- Generate 20 to 30 unique Russian hashtags.
- Prefix every tag with `#` and separate tags with one space.
- Join multiword tags with `_`; use letters, digits, and underscores only.
- Keep every complete tag at 30 characters or fewer.
- Do not use the brand, full product name, or raw SKU parameters as tags.
- Choose only themes, styles, functions, and use contexts supported by the
  source product.
