# Workflow

## Keyword sourcing

```text
source keyword
-> search 1688 candidates
-> extract offerIds
-> collect details through offers
-> map to CanonicalProduct[]
```

Keyword search is deep by default because Ozon draft creation needs title, images, attributes, price tiers, SKUs, supplier info, and package data.

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

Specification parsing uses only structured source facts, known 1688 option
names and values, and explicit key/value syntax. Ambiguous text is kept in
`raw_spec_text` and `unparsed_spec_segments`; the transformer does not invent
`spec1`, `spec2`, or semantic dimensions.

Later phases, not this normalization path, are responsible for Agent category
classification, Ozon `GetAttributes`, attribute-dictionary resolution, missing
package policy, shipping and pricing, Russian content, internal Ozon drafts,
and final Ozon `items[]` requests.
