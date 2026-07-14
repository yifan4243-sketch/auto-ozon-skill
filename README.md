# auto-ozon-skill

Industrial TypeScript Skill for an Agent-driven, resumable 1688-to-Ozon
publication workflow. The repository supplies prompts, JSON contracts,
deterministic validators and Ozon adapters; the host Agent supplies semantic
reasoning with its own LLM. No model vendor SDK or model HTTP call belongs in
this repository.

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

The generic `ozon call` and `ozon fetch-all` bridge remains read-only and locally
blocks `write` and `destructive` methods with `OZON_WRITE_BLOCKED`. Publication
is isolated behind the strongly typed `listing-payload` and `ozon-publish`
steps; it cannot be reached through the generic bridge.

## Commands

```bash
pnpm --filter @auto-ozon/cli dev -- 1688 doctor --json
pnpm --filter @auto-ozon/cli dev -- source keyword "收纳盒" --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source image ./product.jpg --max 5 --json
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 987654321 --json
pnpm --filter @auto-ozon/cli dev -- source similar 123456789 --json
pnpm --filter @auto-ozon/cli dev -- ozon doctor --json --pretty
pnpm --filter @auto-ozon/cli dev -- workflow listing prepare "收纳盒" --stop-after attribute-mapping --json --pretty
pnpm --filter @auto-ozon/cli dev -- workflow listing publish "收纳盒" --decision-file ./decision.json --attribute-agent-file ./attributes.json --draft-content-file ./copy.json --store-profile ./store-profile.json --json --pretty
```

See `docs/COMMANDS.md` for the full CLI surface.

### Retained-facts boundary

The 1688 detail collector now keeps only facts needed by later sourcing,
category selection, and listing preparation: offer identity and URL, the
visible Chinese category breadcrumb, title, attributes, images/detail content,
prices and order quantities, SKU IDs/specifications/prices/images, and package
length/width/height/raw weight. It does not collect or emit numeric 1688
category IDs, supplier identity, receiving or dispatch regions, freight weight,
stock, sales counts, or source package volume. V1 and V2 share this boundary.

## CanonicalProductV2 runtime

The four sourcing commands continue to return CanonicalProduct V1 by default.
Use `--schema-version 2` to opt into the source-fact V2 contract, conversion
summary, and deterministic integrity report:

```bash
pnpm --filter @auto-ozon/cli dev -- source keyword "修枝剪" --max 10 --schema-version 2
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 --schema-version 2 --json-v2 --pretty
pnpm --filter @auto-ozon/cli dev -- source offers 123456789 --schema-version 2 --products-dir data/products
pnpm --filter @auto-ozon/cli dev -- source normalize-v2 --input C:/path/to/saved-offer.json --method offers
```

`--schema-version 2` selects the product data contract. `--json-v2` remains an
independent response-envelope option; both may be used together. Offline replay
accepts exactly one typed `OfferResult` or one typed `OfferBatchResult` and does
not require a browser, login, or network.

V2 preserves keyword/similar discovery context for category work. The category
decision Skill uses the search term, Chinese title, 1688 Chinese category path,
product attributes, and SKU specifications to match the saved Ozon Chinese
category table. The resumable workflow then retrieves attributes and produces
an independent AttributeMappingV2 before validated draft and publication steps.
Original brand attributes remain ordinary product attributes; ownership and
authorization are not inferred. Prohibited-category and logistics restrictions
remain later user-knowledge-base work.

See `docs/CANONICAL_V2_REAL_VALIDATION.md` for the manual real-data validation
procedure. Product workspaces under `data/products/<offer_id>/` are gitignored.

## Vertical workflow architecture

Business logic is organized under `packages/steps/*`; shared browser/MCP,
contracts, storage, and product-workspace compatibility remain horizontal.
`runListingPreparation` stores numbered evidence under `data/runs/<run_id>` and
keeps reusable Ozon dictionaries under `data/cache`. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for package boundaries and the run layout.

## Safety

The adapter does not bypass 1688 risk control. If verification appears, rerun with `--headed` and complete it manually. Sensitive cookies and tokens must not be logged.
