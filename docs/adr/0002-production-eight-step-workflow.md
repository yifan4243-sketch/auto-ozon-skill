# ADR 0002: Production eight-step listing workflow

Status: Accepted. Supersedes the active-flow portion of ADR 0001.

## Decision

The production workflow is fixed to these eight vertical steps:

1. `source-1688`
2. `canonicalize-product`
3. `category-decision`
4. `cost-pricing`
5. `category-attributes`
6. `attribute-mapping`
7. `draft-generation`
8. `listing-submit`

Each product has an independent Manifest V2 run. Step artifacts are immutable
per attempt and are reusable only when input, dependency, implementation and
artifact hashes still match. Old layouts and ListingDraftV1 are read-only and
must never be submitted.

The current Agent owns semantic decisions (category ranking, package estimate,
Russian content, dictionary selection and image text/watermark review). No text
LLM vendor API is part of the repository. Image generation is optional and uses
only a customer-configured image provider.

The submit step accepts `ListingDraftV2.items` without a second payload builder.
It is protected by store authorization, preflight, PublishIntent/Outbox,
idempotency, polling and product-info reconciliation. It does not manage stock,
orders, deletion, unpublishing or purchasing.
