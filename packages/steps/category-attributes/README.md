# Category Attributes Step

Public entry point: `runCategoryAttributes`.

The step deduplicates dynamic category pairs selected by the category-decision
step, fetches Chinese attribute definitions and complete dictionary values,
preserves group associations, separates cache from run evidence, and writes
auditable snapshots below `04-category-attributes`.

MCP process management, safety classification, response-envelope handling, and
secret sanitization remain in `@auto-ozon/adapters-ozon`.
