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
```

Global output flags are available on subcommands: `--json`, `--json-v2`, `--pretty`, `--get`, `--pick`.

Not supported: `serve`, background management, `research`, `compare`, `supplier`, `cart`, `checkout`, `order`, `seller`, `feedback`.

`source keyword` always performs deep detail collection. The old external `--deeppro` flags are not exposed.

## Complete PCDCK/ozon-mcp bridge

The TypeScript adapter exposes all 15 MCP tools provided by `vendor/ozon-mcp`:

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

The Python MCP implementation remains in the external `vendor/ozon-mcp` submodule and is not copied into TypeScript.

The local integration remains read-only for generic execution. `ozon call` and `ozon fetch-all` first describe the requested method and reject `write` or `destructive` methods with `OZON_WRITE_BLOCKED`. Discovery and reference commands can still inspect write-method schemas, examples, limits, related methods, and error catalogs without executing them.
