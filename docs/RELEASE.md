# ozon-master release procedure

`ozon-master` is a pinned installer. A published npm package must identify one
GitHub tag, its exact commit and tree, and the SHA-256 of a deterministic
`git archive` of that commit. The installer rejects placeholder or moving refs.

## Release `v1.0.0-rc1`

1. Finish and commit the intended release on `dev`.
2. Complete the required automated and real-store gates documented in ADR 0002.
3. Merge the verified commit to `main`; do not rebuild from a different commit.
4. Create and push the annotated tag:

   ```powershell
   git tag -a v1.0.0-rc1 -m "ozon-master v1.0.0-rc1"
   git push origin v1.0.0-rc1
   ```

5. From that clean tagged worktree, inspect and publish the npm package:

   ```powershell
   $env:OZON_MASTER_RELEASE_TAG = 'v1.0.0-rc1'
   pnpm --filter ozon-master pack:check
   pnpm --filter ozon-master publish --access public --tag next
   Remove-Item Env:OZON_MASTER_RELEASE_TAG
   ```

   `prepack` injects the pinned manifest into the tarball and `postpack`
   restores the tracked placeholder, so the dry run does not dirty the
   release worktree before `publish`.

6. Create a GitHub Release for the same `v1.0.0-rc1` tag. Record the npm
   version and package integrity in the release notes.
7. Confirm the documented command installs only the tagged commit:

   ```powershell
   pnpm dlx ozon-master@1.0.0-rc.1 init --agent all
   ```

Never publish from a dirty worktree, never change the release manifest by hand,
and never point a published package at `main`, `dev`, or another moving branch.
