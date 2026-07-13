# Attribute Mapping Step

Public entry point: `runAttributeMapping`.

This step is deliberately separate from draft generation. It maps retained
CanonicalProductV2 facts and validated Agent selections into Ozon attributes,
then classifies identical group values as common attributes and differing values
as per-SKU variant attributes. It never writes Russian copy, price, stock, media,
or publishing payloads.
