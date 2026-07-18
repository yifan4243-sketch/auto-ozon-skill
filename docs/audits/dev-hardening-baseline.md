# Dev hardening RC1 baseline

- Recorded: 2026-07-18 (Asia/Shanghai)
- Branch: `codex/dev-hardening-rc1`
- Baseline commit: `e1e37cfdaa143b02aebdc41b40a342a2b638b803`
- Remote baseline: `origin/dev` at the same commit
- Node.js: `v20.20.2`
- pnpm: `9.0.0`
- Working tree before baseline: clean

## Command results

| Command | Exit | Result |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Lockfile install completed. |
| `pnpm verify:graph` | 0 | Workspace dependency graph accepted. |
| `pnpm build` | 0 | TypeScript project-reference build completed. |
| `pnpm verify:packages` | 0 | Built workspace import/package checks completed. |
| `pnpm verify:pack` | 1 | Ordinary pack invoked strict release preparation and required missing tag `v1.0.0-rc1`. |
| `pnpm test:fast` | 1 | 34 files: 9 failed, 25 passed. 218 tests: 34 failed, 184 passed, 0 skipped. |

The complete command logs are retained outside the repository under
`%USERPROFILE%/.cache/auto-ozon-runtime/baseline-e1e37cf/` so the repository
does not acquire generated test output.

## Failing test files and initial root cause classification

| Test file | Failed | Initial root cause | Classification |
|---|---:|---|---|
| `tests/unit/steps/attribute-mapping/attribute-mapping.test.ts` | 12 | V1 fixtures/examples and Agent content input do not satisfy AttributeMappingV2, audit, snapshot and ContentBundle contracts. Several assertions dereference missing V2 data after the command correctly reports failure. | Fixture/test migration plus contract error handling |
| `tests/unit/job-store/job-store.test.ts` | 3 | `better-sqlite3` in the existing workspace was compiled under Node 24 (ABI 137), not the required Node 20 runtime. | Environment/native dependency rebuild; then lifecycle coverage audit |
| `tests/unit/steps/listing-submit/preflight.test.ts` | 2 | Draft fixture lacks V2 `sku_bindings`; preflight directly calls `.map()` without a runtime contract guard. | Code defect plus fixture migration |
| `tests/unit/steps/listing-submit/listing-submit.test.ts` | 4 | Tests still construct old submit inputs and omit the persisted preflight/authorization binding required by the new path. | Fixture/test migration; authorization model still incomplete |
| `tests/unit/adapters-1688/sourcing.test.ts` | 1 | CLI command snapshot predates `setup`, `review-console` and batch/category commands. | Expected CLI baseline migration |
| `tests/unit/steps/draft-generation/draft-generation.test.ts` | 3 | Draft fixtures omit ListingDraftV2 upstream hashes, ContentBundle, ImageBundle and snapshot bindings. | Fixture/test migration |
| `tests/integration/listing-preparation.test.ts` | 5 | All failures are masked by the Node 24/Node 20 `better-sqlite3` ABI mismatch. | Environment first; integration behavior must be rerun afterward |
| `tests/unit/adapters-ozon/ozon-mcp.test.ts` | 1 | Test expects ambient Seller credentials, while the new store-scoped MCP path intentionally starts without ambient credentials. Seller/Performance semantics need explicit coverage. | Expected security behavior plus test migration |
| `tests/unit/image-pipeline/image-pipeline.test.ts` | 3 | Tests access `img.example.com`; the production pipeline performs real fetches, so fake domains fail and introduce network coupling. | Test defect and image security/performance code gap |

## Pack failure

`scripts/verify-pack.mjs` runs `pnpm pack` for `ozon-master`. Its `prepack`
invokes `packages/ozon-master/scripts/prepare-release.mjs`, which performs
`git rev-parse v1.0.0-rc1^{commit}`. An ordinary, untagged development commit
therefore cannot pass package verification. Package-content verification and
strict tagged-release verification must be separated.

## Baseline conclusion

The baseline is not mergeable and not an RC. Build topology is healthy, but
ordinary CI packaging is structurally impossible, V2 test data is incomplete,
persistent draft reads are not runtime-safe, image tests depend on external
network behavior, and native Node 20 dependencies need a clean rebuild.
