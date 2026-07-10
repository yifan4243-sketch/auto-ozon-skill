# JSON Contracts

## CommandResult

Every adapter entry returns:

```ts
interface CommandResult<T = unknown> {
  ok: boolean;
  command: string;
  runId?: string;
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
- supplier identity and location
- Chinese title, images, attributes, price tiers, SKUs, package info
- validation status, warnings, and errors

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
    source_category_id: string | null;
  };
  supplier: SupplierSourceFacts;
  product: ProductSourceFacts;
  skus: CanonicalSkuV2[];
  sku_analysis: SkuAnalysisV2;
  validation: ValidationReport;
}
```

Every `CanonicalSkuV2` retains its own price, multi-price, supplier stock,
sale count, image, parsed source specifications, unparsed specification
segments, and package object. Package dimensions and raw weight are never
promoted out of the SKU. `weight_unit` is `"g"`, `"kg"`, or `"unknown"` and
is not inferred from the numeric weight.

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
