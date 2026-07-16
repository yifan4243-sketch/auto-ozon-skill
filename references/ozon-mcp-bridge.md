# Ozon MCP bridge

The vendored MCP source is `vendor/ozon-mcp/`. Its curated workflow catalogue
is `vendor/ozon-mcp/src/ozon_mcp/knowledge/workflows.yaml`. The bridge command
implementation is `apps/cli/src/commands/ozon.ts`.

## Discover the current API catalogue

Run these from the repository root. The current bundled Swagger snapshot has
approximately 466 methods; treat the CLI response as the source of truth.

```powershell
pnpm exec tsx apps/cli/src/cli.ts ozon doctor
pnpm exec tsx apps/cli/src/cli.ts ozon sections list
pnpm exec tsx apps/cli/src/cli.ts ozon methods search "product import" --api seller --safety write
pnpm exec tsx apps/cli/src/cli.ts ozon methods describe ProductAPI_GetProductInfoList
pnpm exec tsx apps/cli/src/cli.ts ozon methods related ProductAPI_GetProductInfoList
pnpm exec tsx apps/cli/src/cli.ts ozon methods examples ProductAPI_GetProductInfoList
pnpm exec tsx apps/cli/src/cli.ts ozon reference rate-limits --operation-id ProductAPI_GetProductInfoList
pnpm exec tsx apps/cli/src/cli.ts ozon reference errors --operation-id ProductAPI_GetProductInfoList
```

Use `ozon call <operationId> --params '<json>'` only for methods classified as
read-only. Use `ozon fetch-all` only for read-only paginated methods. Do not
call write or destructive endpoints through the generic bridge.

## The 13 MCP curated workflows

Inspect the live definition, ordered calls, pagination, and caveats with:

```powershell
pnpm exec tsx apps/cli/src/cli.ts ozon workflows list
pnpm exec tsx apps/cli/src/cli.ts ozon workflows get sync_products_catalog
```

| Name | Purpose |
| --- | --- |
| `sync_orders_fbs` | Incrementally sync FBS/rFBS orders. |
| `sync_orders_fbo` | Incrementally sync FBO orders. |
| `sync_products_catalog` | Snapshot seller products, attributes, prices, and category names. |
| `sync_finance_transactions` | Sync financial transactions for unit economics. |
| `sync_analytics_daily` | Sync daily sales, revenue, and order analytics. |
| `sync_advertising_campaigns` | Sync advertising campaigns and details. |
| `sync_warehouse_stocks` | Sync FBS/rFBS warehouse stocks. |
| `sync_returns_rfbs` | Sync rFBS returns. |
| `oos_risk_analysis` | Identify out-of-stock risk. |
| `cabinet_health_check` | Diagnose seller cabinet health. |
| `content_audit` | Audit product-card content quality. |
| `pricing_analysis` | Analyze price formation and price indices. |
| `warehouse_stock_distribution` | Analyze inventory distribution across warehouses. |

These workflows analyze an existing Ozon seller cabinet. They do not replace
the eight-step 1688-to-Ozon listing workflow and do not select products from
1688.
