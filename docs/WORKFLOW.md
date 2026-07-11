# Workflow

## Keyword sourcing

```text
source keyword
-> search 1688 candidates
-> extract offerIds
-> collect details through offers
-> map to CanonicalProduct[]
```

Keyword search is deep by default because later listing preparation needs title,
Chinese category path, images, attributes, prices, SKUs, and package dimensions/weight.

## Image sourcing

```text
source image
-> upload/search image on 1688
-> get candidate offerIds
-> collect details through offers
-> map to CanonicalProduct[]
```

Image search is only a candidate-finding stage. Detail collection is centralized in `offers`.

## Offers sourcing

```text
source offers <offerIds...>
-> deduplicate IDs in input order
-> collect each product detail serially
-> return successes and per-ID failures
```

## Similar sourcing

```text
source similar <offerId>
-> call official 1688 similar page
-> collect returned candidate details through offers
```

Similar lookup does not fall back to keyword search or image search. If the official entry is unavailable, the adapter returns `SIMILAR_UNAVAILABLE`.

## CanonicalProductV2 normalization

The phase-one normalization path is independent from collection and from the
existing V1 sourcing result:

```text
1688 raw OfferResult
-> offerToCanonicalV2
-> deterministic source specification parsing
-> per-SKU package matching and assembly
-> common/varying field and source variant analysis
-> CanonicalProductV2 validation report
```

Package matching is ordered and exact:

1. exact `packageInfo.skuId` to `sku.skuId`;
2. when ID matching fails, exact full specification text after basic whitespace,
   entity, and delimiter normalization;
3. otherwise no package is inherited and the SKU package fields remain null.

Package arrays are never joined by index, and one SKU's package is never copied
to another SKU. A no-SKU offer produces one `DEFAULT` SKU; a real single SKU
keeps its source ID.

After matching, an empty package record is still reported as missing. Raw weight
must be at least `3` to be retained; smaller values become `null` without unit
conversion. Package length, width, and height must be positive; source volume is
not collected. Empty or
duplicate source SKU IDs are validation errors and block the V2 product; field
comparison uses collision-free positional keys so invalid IDs cannot overwrite
one another in `values_by_sku`.

Specification parsing uses only structured source facts, known 1688 option
names and values, and explicit key/value syntax. Ambiguous text is kept in
`raw_spec_text` and `unparsed_spec_segments`; the transformer does not invent
`spec1`, `spec2`, or semantic dimensions.

Later phases, not this normalization path, are responsible for Agent category
classification, Ozon `GetAttributes`, attribute-dictionary resolution, missing
package policy, shipping and pricing, Russian content, internal Ozon drafts,
and final Ozon `items[]` requests.

## Ozon category decision V0

```text
CanonicalProductV2
-> Agent identifies single SKU, normal variants, mixed product, or unclear structure
-> read-only lexical search of the committed Chinese Ozon category tree
-> Agent selects a description-category/type pair for each SKU group
-> deterministic category-pair and complete SKU-coverage validation
-> CategoryDecisionV1
```

The category tree under `data/ozon/categories` is the only category source. A
`type_id` is never validated alone because the tree contains repeated type IDs.
All source SKUs must appear exactly once in a category group or in the unassigned
list. Unassigned SKUs, invalid pairs, or blocked source products block the
decision. This stage does not use category analytics and does not retrieve Ozon
attributes or create listing drafts.

## V2 runtime sourcing

```text
keyword / image / offers / similar
-> collect candidate details once as typed OfferResult records
-> apply sku-max directly to OfferResult when requested
-> map the same selected batch to V1 (default) or V2 (explicit)
-> summarize V2 facts
-> compare OfferResult against CanonicalProductV2
-> optionally save an auditable run
```

`--schema-version 2` chooses the product contract. `--json-v2` independently
chooses the existing response envelope. No command performs a V1 collection and
then tries to recover OfferResult from an unknown `raw` shape.

Keyword runs store the same original search term on every returned product.
Similar runs store the seed offer ID. Offers and image runs store null discovery
context, and the image path is not included in CanonicalProductV2.

## Audit runs and offline replay

`--save-dir` creates a unique run directory:

```text
<save-dir>/<run_id>/
  manifest.json
  raw/<offer_id>.json
  canonical-v2/<offer_id>.json
  integrity-report.json
  failures.json
```

Only reconstructed retained OfferResult fields are written to `raw`; unknown
fields, browser responses, cookies, tokens, credentials, image paths, supplier
facts, freight/regions, numeric category IDs, stock, sales, and volume are not
copied. `source normalize-v2` accepts a current or legacy OfferResult or
OfferBatchResult for deterministic replay without network access. Legacy-only
keys are accepted and ignored without mutating the input object.

Validation warnings describe source-data gaps. Integrity violations describe
conversion bugs. The latter fail the command but still allow completed
diagnostic artifacts to remain on disk.

Original brand attributes are source facts and are not interpreted as ownership
or authorization claims. Category selection, prohibited-category rules, and
logistics restrictions remain future stages. The future category Agent will use
the search term, Chinese title, 1688 Chinese category path, attributes, and SKU
specifications to match the saved Ozon Chinese category table; this runtime does
not implement that matching.
