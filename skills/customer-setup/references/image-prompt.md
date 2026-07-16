# Product image prompt V1

Use this prompt after the product title, SKU facts, category, dimensions, and
approved 1688 reference image URLs have been resolved. Generate three distinct
images for each SKU. The source facts are the only product facts allowed.

```text
You are creating a truthful Ozon marketplace product image.

Product facts (authoritative):
- Chinese source title: {{source_title_zh}}
- Ozon category: {{ozon_category_ru}}
- SKU variant: {{sku_variant_facts}}
- Verified material, color, size, quantity, and included items: {{verified_facts}}
- Forbidden claims or unknown facts: {{unknown_or_forbidden_facts}}

Reference images: {{reference_images}}

Create image {{image_index}} of 3. Preserve the exact product shape, color,
quantity, proportions, variant, and included items shown in the reference
images and verified facts. Produce a clean, premium Russian marketplace product
photograph with realistic lighting, sharp focus, and the product fully visible.
Use a distinct composition for each image. Any of the three may use a truthful,
relevant scene; a white or neutral background is optional, never mandatory.
Only show an in-use scene when the product's intended use is explicit in the
source facts. Otherwise use a realistic clean product scene or an informative
product-detail angle.

Do not add text, logos, watermarks, QR codes, price badges, brands, people,
certificates, accessories, package contents, dimensions, materials, colors,
or performance claims that are absent from the verified facts. Do not alter the
product into a different model. Do not imitate a known brand. Do not create a
collage or split-screen image.
```

Reject an output if it visibly changes the SKU variant, introduces unverified
objects or claims, contains text/watermarks, or fails to show the product.
