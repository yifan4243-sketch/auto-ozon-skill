# auto-ozon-skill

TypeScript monorepo for Ozon seller automation. The implemented foundation currently includes the 1688 sourcing adapter and a complete TypeScript bridge to `PCDCK/ozon-mcp`.

## 1688 sourcing

The 1688 collection engine is migrated from [superjack2050/1688-cli](https://github.com/superjack2050/1688-cli) into `packages/adapters-1688` as TypeScript source. This project keeps only sourcing capabilities:

- login, logout, whoami, doctor
- profile list/status
- keyword search with default deep product-detail collection
- image search for candidate offers, with details collected through `offers`
- `offers` for one or more offer IDs
- official similar-offer lookup
- debug list/last/show

Not supported: cart, checkout, order, seller chat, supplier research, research, compare, feedback, automatic purchasing, or any daemon/background process.

## Ozon MCP bridge

Ozon API discovery and guarded read-only calls are bridged through the external [PCDCK/ozon-mcp](https://github.com/PCDCK/ozon-mcp) MCP server in `vendor/ozon-mcp`. The Python engine remains a vendor submodule and is not copied into `packages/adapters-ozon/src`.

The TypeScript adapter provides wrappers and CLI commands for all 15 MCP tools: method and section discovery, examples, related methods, workflows, rate limits, error catalog, Swagger metadata, subscription information, pagination, and generic API calls.

Runtime availability follows the upstream MCP server:

- 12 discovery/reference tools work without Ozon credentials.
- `ozon_call_method` and `ozon_fetch_all` appear when Seller or Performance credentials are configured.
- `ozon_get_subscription_status` appears when Seller credentials are configured.

```bash
git submodule update --init --recursive
cd vendor/ozon-mcp
uv sync
uv run ozon-mcp --help
cd ../..
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon reference swagger-meta --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods search "product import" --api seller --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods describe ProductAPI_ImportProductsV3 --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods examples ProductAPI_ImportProductsV3 --json --pretty
```

The current Ozon integration phase is read-only. `ozon call` and `ozon fetch-all` describe the target method first and locally block `write` and `destructive` methods with `OZON_WRITE_BLOCKED`.

## Commands

```bash
pnpm --filter @auto-ozon/cli dev -- 1688 doctor --json
pnpm --filter @auto-ozon/cli dev -- source keyword "收纳盒" --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source image ./product.jpg --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 987654321 --json
pnpm --filter @auto-ozon/cli dev -- source similar 123456789 --json
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
```

See `docs/COMMANDS.md` for the full CLI surface.

## Safety

The adapter does not bypass 1688 risk control. If verification appears, rerun with `--headed` and complete it manually. Sensitive cookies and tokens must not be logged.
