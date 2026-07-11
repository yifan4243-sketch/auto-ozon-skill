# Changelog

## Unreleased

- Redefine the 1688 collection boundary around retained product facts shared by V1 and V2.
- Replace numeric 1688 category IDs with visible normalized Chinese category paths.
- Remove supplier/freight/region, stock, sales, and source package volume from collection, canonical contracts, analysis, integrity checks, and artifacts.
- Keep legacy OfferResult offline replay compatible by accepting and dropping deprecated input keys.
- Remove search controls that depended on supplier, region, verification, turnover, advertising, or sales data.
- Add opt-in CanonicalProductV2 runtime output for all four 1688 source commands.
- Preserve keyword and similar discovery context without storing local image paths.
- Add SourcingResultV2 summaries and deterministic conversion integrity reports.
- Add typed offline OfferResult replay with `source normalize-v2`.
- Add safe, non-overwriting V2 audit run directories and gitignore local validation data.
- Keep CanonicalProduct V1 as the default and keep `--json-v2` envelope behavior independent.
