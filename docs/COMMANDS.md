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

auto-ozon ozon doctor --json --pretty

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

auto-ozon ozon call ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --json --pretty
auto-ozon ozon fetch-all ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --max-items 10000 --json --pretty

auto-ozon ozon workflows list --category catalog --json --pretty
auto-ozon ozon workflows get cabinet_health_check --json --pretty

auto-ozon workflow category inspect "收纳盒" --decision-file decision.json --json --pretty
auto-ozon workflow listing prepare "收纳盒" --stop-after attribute-mapping --json --pretty
```

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
  --stop-after attribute-mapping \
  --json --pretty

auto-ozon workflow listing prepare "收纳盒" \
  --run-id listing-cup-001 \
  --start-from category-attributes \
  --force-step category-attributes \
  --continue-on-review \
  --json --pretty
```

The workflow reuses successful artifacts, stops on `needs_review` by default,
and reruns downstream dependants when a step is forced. Supported step names
are `source-1688`, `canonicalize-product`, `category-decision`,
`category-attributes`, and `attribute-mapping`. The workflow always ends after
the factual attribute mapping artifact is validated.

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
- `ozon_call_method` and `ozon_fetch_all` are available when Seller or Performance credentials are configured.
- `ozon_get_subscription_status` is available only when Seller credentials are configured.

The Python MCP implementation remains in the external `vendor/ozon-mcp` submodule and is not copied into TypeScript.

The local integration remains read-only for generic execution. `ozon call` and `ozon fetch-all` first describe the requested method and reject `write` or `destructive` methods with `OZON_WRITE_BLOCKED`. Discovery and reference commands can still inspect write-method schemas, examples, limits, related methods, and error catalogs without executing them.
