# ozon-master release procedure

`ozon-master` is a pinned installer. A published npm package must identify one
GitHub tag, its exact commit and tree, and the SHA-256 of a deterministic
`git archive` of that commit. The installer rejects placeholder or moving refs.

## Ordinary package verification is not a release

`pnpm verify:pack` and `pnpm --filter ozon-master pack:check` are safe on a
normal, untagged development commit. They validate tarball contents and must not
change tracked files or require a Release Tag. `prepack` only runs
`prepare-package.mjs`, which checks required package files and deliberately
leaves the tracked `unreleased` manifest unchanged.

Strict tag, clean-worktree and immutable-manifest checks are separate and run
only through `release:prepare` / `release:verify` in the Release workflow.

## Release `v1.0.0-rc1`

1. Finish and commit the intended release on `dev`.
2. Complete the required automated and real-store gates documented in ADR 0002.
3. Merge the verified commit to `main`; do not rebuild from a different commit.
4. Create and push the annotated tag:

   ```powershell
   git tag -a v1.0.0-rc1 -m "ozon-master v1.0.0-rc1"
   git push origin v1.0.0-rc1
   ```

5. From that clean tagged worktree, prepare and verify the immutable manifest,
   inspect the tarball, publish from the reviewed release process, and restore
   the tracked placeholder afterward:

   ```powershell
   $env:OZON_MASTER_RELEASE_TAG = 'v1.0.0-rc1'
   pnpm --filter ozon-master release:prepare
   pnpm --filter ozon-master release:verify
   pnpm --filter ozon-master pack:check
   pnpm --filter ozon-master publish --access public --tag next
   pnpm --filter ozon-master release:reset
   Remove-Item Env:OZON_MASTER_RELEASE_TAG
   ```

   Run `release:reset` in a `finally`/cleanup step if publishing fails. The
   Release verification workflow performs prepare/verify/pack/reset without
   publishing and asserts that the worktree is clean afterward. Publishing is
   never part of ordinary CI and is not performed by this hardening task.

6. Create a GitHub Release for the same `v1.0.0-rc1` tag. Record the npm
   version and package integrity in the release notes.
7. Confirm the documented command installs only the tagged commit:

   ```powershell
   pnpm dlx ozon-master@1.0.0-rc.1 init --agent all
   ```

Never publish from a dirty worktree, never change the release manifest by hand,
and never point a published package at `main`, `dev`, or another moving branch.
