# Ozon MCP Setup

`auto-ozon-skill` uses [PCDCK/ozon-mcp](https://github.com/PCDCK/ozon-mcp) as an external vendor MCP engine. The Python project stays in `vendor/ozon-mcp` as a git submodule. Do not copy or rewrite it into `packages/adapters-ozon/src`.

## Setup

```bash
git submodule update --init --recursive
cd vendor/ozon-mcp
uv sync
uv run ozon-mcp --help
cd ../..
```

The TypeScript bridge starts the MCP server with:

```bash
uv --directory vendor/ozon-mcp run ozon-mcp
```

Environment overrides:

- `OZON_MCP_DIR`: absolute or relative path to a different `ozon-mcp` checkout
- `OZON_MCP_COMMAND`: command used instead of `uv`
- `AUTO_OZON_ROOT`: repo root used to resolve `vendor/ozon-mcp`

## Credentials

Discovery commands work without Ozon credentials. Seller execution must select
one locally registered store with `--store-id`. The registry contains only the
two environment-variable references; it never contains their values:

- `credentials.client_id.key`
- `credentials.api_key.key`

The CLI resolves those two references for the selected store and passes only
`OZON_CLIENT_ID` and `OZON_API_KEY` to that one MCP child process. Ambient keys
for other stores are not forwarded. `auto-ozon` only reports credential
presence as booleans and never prints secret values.

## Commands

```bash
auto-ozon ozon --store-id <Client-Id> doctor --json --pretty
auto-ozon ozon methods search "product list" --json --pretty
auto-ozon ozon methods describe ProductAPI_GetProductList --json --pretty
auto-ozon ozon workflows list --json --pretty
auto-ozon ozon workflows get cabinet_health_check --json --pretty
```

Read-only execution is available through the PCDCK execution tools when credentials are configured:

```bash
auto-ozon ozon --store-id <Client-Id> call ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --json --pretty
auto-ozon ozon --store-id <Client-Id> fetch-all ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --max-items 10000 --json --pretty
```

## Safety

Generic MCP execution is read-only. Before `call` or `fetch-all`, the bridge calls `ozon_describe_method` and checks `safety`.

- `safety: "read"`: allowed
- `safety: "write"` or `"destructive"`: blocked locally with `OZON_WRITE_BLOCKED`
- Missing execution tools return `OZON_EXECUTION_TOOLS_DISABLED`

Generic `ozon call` and `ozon fetch-all` never expose writes. Product import is
available only through `workflow listing publish/resume`, which uses the
strongly typed `listing-submit` adapter and the fixed endpoints
`/v3/product/import`, `/v1/product/import/info`, and
`/v3/product/info/list`. Price/stock mutation, archive, delete, arbitrary
media upload and inventory update remain unavailable.
