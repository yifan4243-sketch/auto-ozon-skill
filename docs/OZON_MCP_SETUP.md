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

Discovery, workflow, graph and reference commands work without Ozon
credentials. Authenticated execution must select one locally registered store
with `--store-id`. Seller and Performance credentials are distinct; configuring
one does not authenticate the other. The registry contains only environment
variable references and never their values:

- `credentials.client_id.key`
- `credentials.api_key.key`
- `performance_credentials.client_id.key` (optional)
- `performance_credentials.client_secret.key` (optional)

For a Seller call, the CLI resolves only Seller references and passes
`OZON_CLIENT_ID`/`OZON_API_KEY`. For an authenticated Performance call it
resolves only the Performance references and passes
`OZON_PERFORMANCE_CLIENT_ID`/`OZON_PERFORMANCE_CLIENT_SECRET`. A workflow that
explicitly needs both may receive both scopes. The bridge never forwards the
whole `process.env`, and credentials from other stores are not forwarded.
`setup doctor` reports only `seller_credentials_configured` and
`performance_credentials_configured` booleans.

Performance method **discovery** remains available without Performance
credentials. Authenticated advertising/Performance execution without the
optional pair fails structurally with `PERFORMANCE_CREDENTIALS_NOT_CONFIGURED`;
do not describe all discoverable methods as immediately callable.

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
