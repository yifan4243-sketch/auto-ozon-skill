# JSON Contracts

## CommandResult

Every adapter entry returns:

```ts
interface CommandResult<T = unknown> {
  ok: boolean;
  command: string;
  data?: T;
  warnings: WarningObject[];
  errors: ErrorObject[];
  nextActions: string[];
}
```

Errors are structured and mark recoverability.

## CanonicalProduct V1

1688 detail results map to `CanonicalProduct` with:

- `source.platform = "1688"`
- `source.collectionMethod = "keyword" | "image" | "offers" | "similar"`
- `source.sourceCategoryPathZh` with the visible broad-to-specific Chinese path
- Chinese title, images, attributes, price tiers, SKUs, package info
- raw package weight with unknown unit; no numeric-unit guessing or conversion
- validation status, warnings, and errors

V1 has no supplier, freight/region, SKU stock, sales, source volume, or numeric
1688 category ID fields.

## OfferResult retained facts

The collection-layer `OfferResult` contains offer identity/title/URL,
`categoryPathZh`, price range/min/max, unit and order quantities, price tiers,
detail URL, attributes, package length/width/height/raw weight, SKU options,
SKU ID/raw spec/price/multi-price/image, main image, and gallery images.

The contract does not define empty compatibility placeholders for `supplier`,
`freight`, `categoryId`, `saledCount`, SKU `stock`/`saleCount`, or package
`volume`. Legacy offline files may contain those keys, but the input codec
ignores them and reconstructs a current OfferResult without mutating the input.

## SourcingResult

`source keyword`, `source image`, `source offers`, and `source similar` return:

```ts
interface SourcingResult {
  mode: "keyword" | "image" | "offers" | "similar";
  query?: string;
  imagePath?: string;
  offerIds?: string[];
  total: number;
  success: number;
  failed: number;
  items: CanonicalProduct[];
  raw?: unknown;
  failures: Array<{ offerId?: string; code: string; message: string; recoverable: boolean }>;
}
```

Partial detail failures remain in `failures`; successful products still appear in `items`.

## CanonicalProductV2

`CanonicalProductV2` is the source-fact contract for deterministic 1688 SKU
normalization. Its JSON field names use English `snake_case`; Chinese text is
preserved only in source values such as titles, attributes, option names, and
option values.

```ts
interface CanonicalProductV2 {
  schema_version: 2;
  source: {
    platform: "1688";
    offer_id: string;
    offer_url: string;
    collected_at: string;
    collection_method: "keyword" | "image" | "offers" | "similar";
    detail_url: string | null;
    source_category_path_zh: string[];
    discovery_context: {
      search_term: string | null;
      seed_offer_id: string | null;
    };
  };
  product: ProductSourceFacts;
  skus: CanonicalSkuV2[];
  sku_analysis: SkuAnalysisV2;
  validation: ValidationReport;
}
```

Every `CanonicalSkuV2` retains its own price, multi-price, image, parsed source
specifications, unparsed specification segments, and package object. Package
dimensions and raw weight are never
promoted out of the SKU. `weight_unit` is `"g"`, `"kg"`, or `"unknown"` and
is not inferred from the numeric weight. A raw source weight below `3` is not
considered valid package weight and is stored as `null` with unit `"unknown"`.
Package length, width, and height must be positive; zero, negative, or
non-finite values are stored as `null`. Source volume is not collected or
represented.

`sku_analysis` is a non-destructive summary containing:

- whether source SKUs existed, whether the product is multi-SKU, and the
  normalized SKU count;
- common and varying values for price, multi-price, image, per-SKU package
  fields, and source specification dimensions;
- source variant dimensions and missing dimensions by SKU;
- missing fields, duplicate complete specification combinations, and warnings.

Common values remain present on every item in `skus`; the summary never removes
source facts. The contract contains no Ozon category IDs, Ozon attribute IDs,
Russian content, shipping or sale-price calculations, Agent output, Ozon draft,
or final `items[]` request.

`sku_analysis` never analyzes supplier stock, sales count, or package volume.
Source SKU IDs are validated before the product can be considered usable. Empty
or duplicate IDs add validation errors and block the product. For an invalid ID
set, `values_by_sku` uses deterministic positional suffixes so no comparison
value can be overwritten silently.

`discovery_context.search_term` stores the original keyword for keyword runs.
`discovery_context.seed_offer_id` stores the original seed for similar runs.
Offers, image, and context-free offline conversion use null values. Local image
paths are never stored in CanonicalProductV2.

## SourcingResultV2

```ts
interface SourcingResultV2 {
  schema_version: 2;
  mode: "keyword" | "image" | "offers" | "similar";
  query: string | null;
  offer_ids: string[];
  total: number;
  success: number;
  failed: number;
  items: CanonicalProductV2[];
  failures: Array<{
    offer_id: string | null;
    code: string;
    message: string;
    recoverable: boolean;
  }>;
  summary: CanonicalV2RunSummary;
  integrity_report: CanonicalV2IntegrityReport;
  artifacts: CanonicalV2RunArtifacts | null;
  raw?: unknown;
}
```

When persistence is enabled, `artifacts.products_root` is the selected product
workspace root and `artifacts.products[]` contains one entry per offer. Each
entry points to `<products_root>/<offer_id>/manifest.json`,
`1688_data/source.json`, `1688_data_v2/product.json`, and the product integrity
report. Compatible category commands use `ozon_category`; the five-step workflow
stores its artifacts under `data/runs/<run_id>`.

Collection `success`/`failed` counts are separate from product validation. A
blocked or needs-review product remains in `items`; it is not a collection
failure. `summary` counts products, SKUs, validation statuses, package match
methods, missing packages/weights, unparsed specs, and duplicate spec groups.

`validation` reports incomplete or reviewable source facts. `integrity_report`
instead detects program conversion damage such as missing SKUs, changed prices,
incorrect package normalization, or detail URLs entering the gallery. An
integrity failure returns `V2_INTEGRITY_FAILED` and a non-zero process exit code.

## CategoryDecisionV1

`CategoryDecisionV1` is the downstream Agent decision contract. It records the
source offer, evidence-backed product understanding, representative SKUs,
product structure, category groups, unassigned SKUs, status, warnings, and
errors. Each selected category contains the exact
`description_category_id + type_id`, names, and full Chinese path copied from
the committed Ozon category tree.

Decision status is `decided`, `needs_review`, or `blocked`. Every source SKU must
be covered exactly once. Invalid or disabled category pairs, duplicate or
missing SKU coverage, unassigned SKUs, and blocked source input prevent a
`decided` result. The contract contains no Ozon attributes, Russian copy,
pricing, logistics, draft, or publishing fields.
