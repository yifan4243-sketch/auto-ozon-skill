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
