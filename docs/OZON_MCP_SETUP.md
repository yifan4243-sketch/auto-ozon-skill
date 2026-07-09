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

Discovery commands work without Ozon credentials. Execution tools require Seller API credentials and may be absent from `tools/list` until these are configured:

- `OZON_CLIENT_ID`
- `OZON_API_KEY`

Performance credentials are reported separately:

- `OZON_PERFORMANCE_CLIENT_ID`
- `OZON_PERFORMANCE_CLIENT_SECRET`

`auto-ozon` only reports credential presence as booleans and must not print secret values.

## Commands

```bash
auto-ozon ozon doctor --json --pretty
auto-ozon ozon methods search "product list" --json --pretty
auto-ozon ozon methods describe ProductAPI_GetProductList --json --pretty
auto-ozon ozon workflows list --json --pretty
auto-ozon ozon workflows get cabinet_health_check --json --pretty
```

Read-only execution is available through the PCDCK execution tools when credentials are configured:

```bash
auto-ozon ozon call ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --json --pretty
auto-ozon ozon fetch-all ProductAPI_GetProductList --params '{"filter":{"visibility":"ALL"}}' --max-items 10000 --json --pretty
```

## Safety

This integration phase is read-only. Before `call` or `fetch-all`, the bridge calls `ozon_describe_method` and checks `safety`.

- `safety: "read"`: allowed
- `safety: "write"` or `"destructive"`: blocked locally with `OZON_WRITE_BLOCKED`
- Missing execution tools return `OZON_EXECUTION_TOOLS_DISABLED`

The CLI does not expose publish, submit, price update, stock update, archive, delete, create/update product, import product, upload media, or inventory update commands.
