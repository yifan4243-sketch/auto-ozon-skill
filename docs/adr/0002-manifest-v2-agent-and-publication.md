# ADR 0002: Manifest V2, host-Agent reasoning, and typed publication

Status: accepted

## Decision

New workflows use eight owning step packages and Manifest V2 attempt artifacts.
Legacy run manifests return `LEGACY_RUN_UNSUPPORTED`; they are not migrated,
resumed or deleted.

Semantic category decisions, semantic attribute selections and Russian copy
are produced by the host Agent. The repository does not select, install or call
an LLM provider. It accepts structured Agent output and applies deterministic
source-evidence, Ozon-snapshot and Schema validation.

The generic Ozon MCP bridge remains read-only. Seller writes are isolated in a
typed adapter used by `ozon-publish` after `listing-payload` validation and an
enabled store profile.

## Compatibility window

Deprecated public entry points in `category-intelligence`, `transformer`, and
the V1 mapping/draft exports remain forwarding compatibility surfaces for the
0.x release following this ADR. They are scheduled for removal in the next
major release. New integrations must import the owning step packages and V2
contracts.
