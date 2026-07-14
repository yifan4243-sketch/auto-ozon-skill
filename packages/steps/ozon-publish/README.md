# Ozon publish

The only write-capable Ozon workflow step. It submits a validated
`ListingPayloadV1`, polls the import task in the foreground, preserves partial
success, retries temporary failures at most twice, and resolves confirmed Ozon
SKU identities. It contains no stock, delete, archive, or background behavior.
