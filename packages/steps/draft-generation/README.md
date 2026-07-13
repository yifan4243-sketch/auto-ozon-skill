# Ozon draft generation step

Consumes validated `AttributeMappingV1` plus copy-only Agent input and builds an
auditable `OzonProductDraftV1`. It does not rematch factual attributes and does
not call Ozon write APIs.

Public entry: `runDraftGeneration`.
