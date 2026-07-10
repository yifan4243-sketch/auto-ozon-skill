# CanonicalProductV2 real-data validation

This is a manual validation procedure. It is not a CI test and must not bypass
1688 verification or risk controls.

## Prerequisites

1. Confirm the local 1688 session yourself with `auto-ozon 1688 whoami --verify`.
2. If verification is required, rerun with `--headed` and complete it manually.
3. Prepare 20 to 50 representative offer IDs or keyword/image/similar samples.
4. Use a local directory such as `data/validation/canonical-v2-runs/`; it is
   ignored by Git.

Do not automate hundreds of products, bypass sliders/captchas, use a captcha
solver, or place cookies, tokens, account credentials, or browser profiles in a
fixture.

## Collection examples

```bash
auto-ozon source keyword "修枝剪" \
  --max 20 \
  --schema-version 2 \
  --headed \
  --save-dir data/validation/canonical-v2-runs

auto-ozon source offers 123456789 987654321 \
  --schema-version 2 \
  --save-dir data/validation/canonical-v2-runs \
  --json-v2 \
  --pretty

auto-ozon source similar 123456789 \
  --max 10 \
  --schema-version 2 \
  --save-dir data/validation/canonical-v2-runs
```

Offline replay of a saved typed artifact:

```bash
auto-ozon source normalize-v2 \
  --input data/validation/canonical-v2-runs/<run_id>/raw/123456789.json \
  --method offers \
  --output data/validation/replayed-123456789.json
```

## Review procedure

1. Open `integrity-report.json`; any `fail` is a conversion defect to investigate.
2. Review the manifest totals and failure list.
3. Sample every validation status: valid, warning, needs_review, and blocked.
4. Compare raw and canonical files for SKU count, ID, price, multi-price, stock,
   sale count, SKU image, dimensions, weight, and specification parsing.
5. Confirm keyword products share the original search term and similar products
   share the seed offer ID.
6. Manually convert only useful, fully sanitized cases into repository fixtures.

Recommended coverage:

- no SKU and one SKU;
- color, size, and color-plus-size variants;
- different or partially missing SKU packages;
- source weight below 3;
- missing SKU images and unparsed specifications;
- empty and duplicate SKU IDs;
- original brand attributes;
- multi-price SKUs;
- mixed successful and failed collections.

## Current online status

Real online validation: pending user-provided samples/session.

Do not claim real validation completion unless the commands above were actually
run against user-approved live samples and the resulting reports were reviewed.
