# auto-ozon-skill

TypeScript monorepo for Ozon seller automation. The current implemented slice is the 1688 sourcing adapter.

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

Ozon API discovery and read-only calls are bridged through the external [PCDCK/ozon-mcp](https://github.com/PCDCK/ozon-mcp) MCP server in `vendor/ozon-mcp`. The Python engine remains a vendor submodule and is not copied into `packages/adapters-ozon/src`.

```bash
git submodule update --init --recursive
cd vendor/ozon-mcp
uv sync
uv run ozon-mcp --help
cd ../..
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods search "product list" --json --pretty
pnpm --filter @auto-ozon/cli dev -- ozon methods describe ProductAPI_GetProductList --json --pretty
```

The current Ozon integration phase is read-only. `ozon call` and `ozon fetch-all` are locally blocked for `write` and `destructive` methods.

## Commands

```bash
pnpm --filter @auto-ozon/cli dev -- 1688 doctor --json
pnpm --filter @auto-ozon/cli dev -- source keyword "收纳盒" --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source image ./product.jpg --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 987654321 --json
pnpm --filter @auto-ozon/cli dev -- source similar 123456789 --json
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
```

## Safety

The adapter does not bypass 1688 risk control. If verification appears, rerun with `--headed` and complete it manually. Sensitive cookies and tokens must not be logged.
