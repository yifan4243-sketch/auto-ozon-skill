# Reliability

## 1688 collection

The engine uses inline Playwright sessions with persistent, authorized
profiles. A profile lock prevents concurrent use; stale locks are bounded.
Search preserves successful detail results while recording failed offer IDs.
`offers` validates and de-duplicates IDs while preserving order. Retries are
bounded; risk control requires customer action in `--headed` mode or an
explicit skip policy.

## Manifest V2 and resume

Each product owns one run under `data/runs/<run_id>`. Manifest V2 records input,
dependency and implementation hashes plus artifact size/SHA-256. Atomic writes,
run locks, attempt directories and interrupted-state recovery prevent partial
files from becoming current output. Legacy layouts are preserved read-only.

`--start-from` treats every earlier step as immutable upstream evidence: its
artifacts are integrity/schema checked and read, but absent Provider or Agent
parameters on the resume command do not rewrite metadata or stale upstream
steps. Changed inputs, a forced step or changed upstream hashes stale all
dependants.

Critical persisted contracts are runtime-validated before use, including
CanonicalProductV2, CategoryDecisionV1, CostPricingV1, category attributes,
AttributeMappingV2, ContentBundle, ImageBundle, ListingDraftV2 and
PublishIntent. Damage and legacy versions produce structured errors rather than
unchecked property exceptions.

## Pricing evidence

The only implemented logistics Provider is CEL. Its bundled versioned snapshot
is explicitly `legacy_manual_snapshot` with `verification_status=needs_review`
and unknown capture/validity dates. No unsupported Provider formula is invented.
Complete source package facts that exceed CEL constraints are retained and
return `LOGISTICS_PROVIDER_UNSUPPORTED_PACKAGE` / no applicable tariff; they
are never erased and replaced by a low-confidence estimate.

## Publish intent, reconciliation and idempotency

Before a Seller write, Preflight validates upstream hashes, snapshots, images,
SKU bindings, limits and authorization. The reliability store transactionally
persists Consent, execution authorization, PublishIntent and outbox state. The
idempotency identity is store + offer ID + canonical item hash.

After submission, Ozon's `task_id` is recorded before polling. A timeout is not
proof that creation failed. Resume first reconciles by product/offer and task;
it does not submit again when creation cannot be disproved. Successful SKUs are
retained, and only explicitly recoverable failed SKUs can retry, at most twice.
Unknown remote states become failed/uncertain evidence, never automatic success.

SQLite is the local default. PostgreSQL implementations support transactional
intent/outbox/consent/authorization and a review-state read model. That reader
does not provide shared artifacts or turn the Local Review Console into a team
deployment.

## Tests and CI

Automated tests are offline: fixed 1688/category/commission/fx/tariff fixtures,
mock image fetch and DNS resolver, fake database clients, and Fake Ozon
transport. CI must never call a real Seller write endpoint. Linux and Windows
run frozen install, dependency graph verification, build, package import/pack
checks, tests and a final Git pollution check. Linux additionally produces the
configured critical-module coverage report and dependency audit.
