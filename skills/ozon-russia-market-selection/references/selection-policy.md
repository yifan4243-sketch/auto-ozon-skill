# Category scoring notes

## Data quality

Use `level3` as the default analysis level. Ignore rows with invalid IDs,
negative counts, blank GMV, or incomplete category paths. Values in the same
snapshot are comparable only to other values in that snapshot.

## Opportunity interpretation

| Signal | Preferred direction | Why |
| --- | --- | --- |
| GMV and sold items | High enough, not necessarily highest | Confirms actual demand. |
| GMV growth | Positive | Finds expanding demand. |
| Leader share | Lower | Leaves more room for small sellers. |
| Seller count | Middle range | Avoids both a closed niche and a price war. |
| Buyout rate | Higher | Reduces cancellation/return risk. |
| AIV | Compatible with CEL landed cost | Avoids categories that cannot carry cross-border logistics. |

Do not pick a category with low leader share if it also has negligible sales or
very low buyout. Do not pick a high-growth category from a near-zero GMV base
without marking it experimental and allocating at most five listings.

## Cross-border exclusion review

Before handing off to 1688, mark a category `blocked` when it commonly implies
food, medicine, nicotine, adult goods, hazardous materials, temperature
control, regulated electronics, a restricted brand, or oversized shipment.
Mark uncertain categories `needs_review`; do not treat them as automatic picks.
