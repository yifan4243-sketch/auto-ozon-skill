# Architecture

`auto-ozon-skill` is a pnpm workspace using TypeScript and Node.js 20+.

## Current implemented slice

The 1688 sourcing engine is migrated from `superjack2050/1688-cli` into `packages/adapters-1688/src/engine`.

```text
apps/cli
  auto-ozon command surface

packages/contracts
  CommandResult, CanonicalProduct, SourcingResult

packages/adapters-1688
  engine/auth
  engine/session
  engine/commands
  mappers
  client.ts
```

The session layer is inline-only. It uses Playwright persistent browser contexts, profiles, cookies, locks, events, artifacts, response capture, mtop capture, and recovery. The daemon logic from the source project is intentionally deleted.

## Sourcing pipeline

```text
keyword / image / offerIds / similar
-> 1688 collection
-> offer detail collection through offers
-> CanonicalProduct
-> later Ozon draft transformation
```

`search` always performs detail collection by default. The former optional deep mode is now the normal behavior needed for Ozon listing preparation.

## Removed scope

Cart, checkout, order, seller chat, supplier research, research, compare, feedback, procurement, and automatic purchasing are intentionally excluded.
