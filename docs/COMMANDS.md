# Commands

Supported:

```bash
auto-ozon 1688 login
auto-ozon 1688 logout
auto-ozon 1688 whoami
auto-ozon 1688 doctor
auto-ozon 1688 profile list
auto-ozon 1688 profile status
auto-ozon 1688 debug list
auto-ozon 1688 debug last
auto-ozon 1688 debug show <requestId>

auto-ozon source keyword "收纳盒" --max 10 --json
auto-ozon source image ./product.jpg --max 10 --json
auto-ozon source offers 123456789 987654321 --json
auto-ozon source similar 123456789 --max 10 --json

auto-ozon ozon --store-id <Client-Id> doctor --json --pretty

auto-ozon ozon sections list --json --pretty
auto-ozon ozon sections get ProductAPI --json --pretty

auto-ozon ozon methods search "product import" --api seller --safety write --json --pretty
auto-ozon ozon methods describe ProductAPI_ImportProductsV3 --json --pretty
auto-ozon ozon methods describe --path /v3/product/import --http-method POST --json --pretty
auto-ozon ozon methods related ProductAPI_ImportProductsV3 --max-hops 2 --json --pretty
auto-ozon ozon methods examples ProductAPI_ImportProductsV3 --json --pretty

auto-ozon ozon reference rate-limits --operation-id ProductAPI_GetProductList --json --pretty
auto-ozon ozon reference rate-limits --section ProductAPI --json --pretty
auto-ozon ozon reference errors --operation-id ProductAPI_ImportProductsV3 --json --pretty
auto-ozon ozon reference errors --code InvalidArgument --json --pretty
auto-ozon ozon reference swagger-meta --json --pretty

auto-ozon ozon subscription status --refresh --json --pretty
auto-ozon ozon subscription methods PREMIUM_PLUS --json --pretty

auto-ozon ozon --store-id <Client-Id> call ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --json --pretty
auto-ozon ozon --store-id <Client-Id> fetch-all ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --max-items 10000 --json --pretty

auto-ozon ozon workflows list --category catalog --json --pretty
auto-ozon ozon workflows get cabinet_health_check --json --pretty

auto-ozon workflow category inspect "收纳盒" --store-id <Client-Id> --decision-file decision.json --json --pretty
auto-ozon workflow listing prepare "收纳盒" --stop-after draft-generation --json --pretty
auto-ozon setup doctor --json --pretty
auto-ozon setup publishing enable --store-id 123456 --actor local-owner
auto-ozon setup publishing disable --store-id 123456 --actor local-owner
auto-ozon workflow category refresh-tree --store-id 123456
auto-ozon workflow batch create --batch-id batch-001 --store-id 123456 --count 20 --profiles account-1,account-2
auto-ozon workflow batch run --batch-id batch-001
auto-ozon workflow batch resume --batch-id batch-001
auto-ozon workflow batch status --batch-id batch-001
auto-ozon workflow batch agent-tasks --batch-id batch-001
auto-ozon workflow batch agent-input --batch-id batch-001 --offer-id <offer_id> --kind category --stdin
auto-ozon review-console start
```

`agent-input` accepts a complete `AgentDecisionEnvelopeV1`, not an unbound raw
value. Obtain the current `task_id`, run/input hash and evidence hashes from
`agent-tasks`; place the actual category/pricing/attribute/image decision in
the envelope's `output` field. Stale or cross-run envelopes are rejected.

Global output flags are available on subcommands: `--json`, `--json-v2`, `--pretty`, `--get`, `--pick`.

Keyword search supports `--sort relevance|price-asc|price-desc` and optional
`--price-min`/`--price-max`. Supplier location, verification, turnover,
best-selling, and ad filters are intentionally absent because those source
fields are outside the retained-facts collection boundary.

## CanonicalProductV2 source commands

V1 remains the default. Add `--schema-version 2` to any of the four collection
commands to return `SourcingResultV2` and `CanonicalProductV2`:

```bash
auto-ozon source keyword "修枝剪" --max 10 --schema-version 2
auto-ozon source image ./product.jpg --max 10 --schema-version 2
auto-ozon source offers 123456789 987654321 --schema-version 2
auto-ozon source similar 123456789 --max 10 --schema-version 2
```

`--schema-version` accepts only `1` or `2`; its default is `1`. It controls the
product contract and is independent from `--json-v2`, which controls the outer
response envelope:

```bash
auto-ozon source offers 123456789 \
  --schema-version 2 \
  --json-v2 \
  --pretty
```

All four V2 collection commands accept `--products-dir <directory>`. Every
offer is stored under `<directory>/<offer_id>` with `1688_data`,
`1688_data_v2`, and `ozon_category` subdirectories.
`--products-dir` is rejected on V1.

## Offline V2 replay

```bash
auto-ozon source normalize-v2 \
  --input saved-offer-or-batch.json \
  --method keyword \
  --search-term "修枝剪" \
  --products-dir data/products
```

Options:

- `--input <path>`: required typed `OfferResult` or `OfferBatchResult` JSON;
- `--method <keyword|image|offers|similar>`: defaults to `offers`;
- `--search-term <text>` and `--seed-offer-id <id>`: optional discovery context;
- `--products-dir <directory>`: create or update the standard offer workspace.

Offline replay does not start a browser or access the network. Current files
use the reduced OfferResult contract. Older files containing supplier, freight,
numeric category, stock, sales, or volume fields remain accepted; those keys
are ignored and never copied into output or raw artifacts.

Not supported: `serve`, background management, `research`, `compare`, `supplier`, `cart`, `checkout`, `order`, `seller`, `feedback`.

`source keyword` always performs deep detail collection. The old external `--deeppro` flags are not exposed.

## Resumable listing preparation

`workflow listing prepare` runs the numbered vertical steps and writes evidence
under `data/runs/<run_id>`:

```bash
auto-ozon workflow listing prepare "收纳盒" \
  --run-id listing-cup-001 \
  --decision-file category-decision.json \
  --stop-after draft-generation \
  --json --pretty

# Complete image text/watermark review from the current Agent.
auto-ozon workflow listing prepare "收纳盒" \
  --run-id listing-cup-001 \
  --store-id <Client-Id> \
  --start-from draft-generation \
  --image-review-stdin \
  --json --pretty

# Complete missing package estimates from the current Agent.
auto-ozon workflow listing prepare "收纳盒" \
  --run-id listing-cup-001 \
  --start-from cost-pricing \
  --pricing-agent-stdin \
  --json --pretty

auto-ozon workflow listing prepare "收纳盒" \
  --run-id listing-cup-001 \
  --start-from category-attributes \
  --force-step category-attributes \
  --continue-on-review \
  --json --pretty
```

The workflow reuses valid `succeeded`/`needs_review` artifacts, stops on
`needs_review` by default, and reruns downstream dependants when a step is
forced. When `--start-from` is used, earlier steps are integrity/schema checked
and read only; absent Provider/Agent inputs on the resume command do not stale
or rerun those upstream artifacts. Supported step names
are `source-1688`, `canonicalize-product`, `category-decision`,
`cost-pricing`, `category-attributes`, `attribute-mapping`, and `draft-generation`. Cost pricing runs
after category decision and before category-attribute retrieval. The workflow always ends after
the internal listing draft is validated; it does not submit to Ozon.

Use `--pricing-profile-json` for customer pricing overrides and `--commission-file`
to replace the bundled commission snapshot. New runs write cost pricing under
`04-cost-pricing`, category attributes under `05-category-attributes`, and mappings
under `06-attribute-mapping`, and drafts under `07-draft-generation`; pre-draft manifests are rejected without migration.

## Listing submission

Prepare remains read-only and stops at `draft-generation`. To submit its unchanged
`items[]`, first copy the tracked profile template to the ignored local profile
and provide the referenced environment variables. Then explicitly enable
store-level automatic publishing. This creates `StorePublishingConsentV1` in
the durable reliability store; changing the JSON flag alone is insufficient.
Neither the profile nor command output stores the API key.

```powershell
Copy-Item data/config/ozon-stores.example.json data/config/ozon-stores.local.json
$env:OZON_CLIENT_ID_123456 = '<Client-Id>'
$env:OZON_API_KEY_123456 = '<Seller-API-Key>'

auto-ozon setup publishing enable --store-id <Client-Id> --actor <operator>
auto-ozon workflow listing publish --run-id listing-cup-001 --store-id <Client-Id> --json --pretty
auto-ozon workflow listing resume --run-id listing-cup-001 --store-id <Client-Id> --json --pretty
auto-ozon workflow listing status --run-id listing-cup-001 --json --pretty
auto-ozon setup publishing disable --store-id <Client-Id> --actor <operator>
```

`publish` requires `draft_complete`, CNY items, a passed Preflight, and an
enabled, unrevoked Consent whose store/profile hashes still match. It creates a
run/draft-bound execution authorization from that Consent; it never creates the
Consent itself. It records the task under
`08-listing-submit`, polls it in the foreground, retries only recoverable failed
SKUs up to two times, and reads back confirmed `product_id` values. `resume`
first polls an unfinished task and never resubmits the timed-out batch just for
having timed out. No inventory, URL construction, deletion, archive, or
unlisting operation is available.

## Complete PCDCK/ozon-mcp bridge

The TypeScript adapter provides wrappers for all 15 MCP tools defined by `vendor/ozon-mcp`:

- `ozon_call_method`
- `ozon_fetch_all`
- `ozon_describe_method`
- `ozon_search_methods`
- `ozon_list_sections`
- `ozon_get_section`
- `ozon_list_workflows`
- `ozon_get_workflow`
- `ozon_get_related_methods`
- `ozon_get_examples`
- `ozon_get_rate_limits`
- `ozon_get_subscription_status`
- `ozon_list_methods_for_subscription`
- `ozon_get_swagger_meta`
- `ozon_get_error_catalog`

Runtime registration follows the upstream server:

- 12 discovery, workflow, graph, and reference tools are always available.
- `ozon_call_method` and `ozon_fetch_all` are registered when Seller or Performance credentials are configured; the selected method still determines which credential family is required.
- `ozon_get_subscription_status` is available only when Seller credentials are configured.

The Python MCP implementation remains in the external `vendor/ozon-mcp` submodule and is not copied into TypeScript.

Discovery, workflow, graph and reference tools need no live credentials.
Authenticated Seller reads use `credentials`; authenticated Performance reads
use the distinct optional `performance_credentials`. A store without
Performance Client-Id/Client-Secret may discover Performance contracts but
must receive `PERFORMANCE_CREDENTIALS_NOT_CONFIGURED` for authenticated
Performance execution. Only credentials required by the selected operation are
forwarded; the bridge never copies all of `process.env` into the child.

The local integration remains read-only for generic execution. `ozon call` and `ozon fetch-all` first describe the requested method and reject `write` or `destructive` methods with `OZON_WRITE_BLOCKED`. Discovery and reference commands can still inspect write-method schemas, examples, limits, related methods, and error catalogs without executing them. Listing submission is intentionally separate and uses a fixed typed client limited to import, polling, and product-ID readback.

## Local Review Console

`auto-ozon review-console start` binds only to `127.0.0.1`, runs in the
foreground, and uses a local HttpOnly/SameSite session, same-origin CSRF checks,
request-size limits and strict CSP. It is a single-user local tool. Team mode,
public binding, OIDC login, shared artifacts and multi-node operation are
unsupported. An optional PostgreSQL review-state reader supplies a durable read
model only; it does not change that deployment boundary.
