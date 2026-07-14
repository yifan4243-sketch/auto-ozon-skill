# Attribute Mapping Step

Public entry point: `runAttributeMapping`.

This is the final step in the current workflow. It applies the locked script
defaults, exposes unresolved `agent_tasks` to the current Skill Agent, validates
the returned selections, and writes one `attribute-mapping-v1.json`. Each SKU
contains both auditable mappings and an ID-sorted `ozon_attributes` array.

No external LLM runtime is used. Russian name, description, and hashtags belong
to this step; price, stock, media, and publishing remain out of scope.
