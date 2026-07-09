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

## CanonicalProduct

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
