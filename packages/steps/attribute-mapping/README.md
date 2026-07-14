# Attribute Mapping Step

Public entry point: `runAttributeMapping`.

This step is deliberately separate from draft generation. It maps retained
CanonicalProductV2 facts and validated Agent selections into Ozon attributes,
then classifies identical group values as common attributes and differing values
as per-SKU variant attributes. It never writes Russian copy, price, stock, media,
or publishing payloads.
New workflows use `AttributeMappingV2`, which records the current category
snapshot digest and explicit source path, source value, and normalized value for
every mapped fact. `runAttributeMapping` remains as a one-release V1 facade.
