# Listing payload

Deterministically converts a publish-ready Ozon draft and CanonicalProductV2
into the exact `/v3/product/import` request. This step validates CNY pricing,
VAT, stable offer IDs, existing source image URLs, dimensions, and packaged
weight. It does not call Ozon and never emits stock fields.
