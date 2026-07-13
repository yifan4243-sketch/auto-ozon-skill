# Category Decision Step

Public entry point: `runCategoryDecision`.

The provider performs the semantic product and SKU grouping decision. This step
then validates the fixed JSON schema, the exact Ozon description-category/type
pair, disabled state, names, paths, and complete SKU coverage. When a workflow
context is supplied, the audited decision is written to the run's
`03-category-decision` directory.
