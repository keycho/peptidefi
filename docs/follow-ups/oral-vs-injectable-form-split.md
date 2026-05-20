# Oral vs injectable form split

Status: tracked, not yet planned for implementation. Some peptides
in the data layer are sold by confirmed vendors in both oral
capsule and injectable vial forms. The TWAP algorithm treats every
observation as USD/mg regardless of form, which means the
per-peptide TWAP can drift when the form mix changes between
cycles. This doc tracks the situation and the gating checklist
for splitting heterogeneous peptides into separate codes.

## What's affected today

Migration 0046 added 14 peptides; three of them have heterogeneous
forms across confirmed vendors:

| Code | Oral capsule vendors | Injectable vial vendors | Notes |
| ---- | --------------------- | ----------------------- | ----- |
| KPV | SWISSCHEMS (250mcg x 60 caps) | LIBERTY, GENETIC, PUREHEALTH, VERIFIED, PURETESTED, PANDA | Six vendors ship vials; SWISSCHEMS is the outlier. |
| DIHEXA | LIBERTY (5mg x 60 caps), SWISSCHEMS (5mg x 60 caps, also a 500mg powder) | GENETIC (10mg vial) | Mixed; majority is capsule. |
| MK677 | LIBERTY, GENETIC, SWISSCHEMS (all capsules) | none confirmed | Universally oral. Non-peptide MK-class molecule; tracked alongside peptide GHS for cohort consistency. |

The injectable / oral split exists for pre-existing peptides too,
in smaller numbers (e.g. TESO is sold as both capsules and vials
by some vendors). This tracker covers the pattern, not just the
0046 batch.

## Pricing-divergence risk

Oral capsule peptides typically carry a form premium that
injectable vials do not: capsule shell, filler, encapsulation
labor, distinct supply chain, oral-only customer base. Empirically
this premium can run 30 to 80 percent above the equivalent
injectable USD/mg for the same molecule. Per-vendor data over a
7-day observation window will tell us the real magnitude for our
14 new peptides.

The TWAP algorithm in `apps/worker/src/twap.ts` is
`filtered_median_v1`, a straight median over included observations.
When the form mix is consistent across a peptide's vendor panel
(all oral, or all injectable), the median is stable. When the mix
is mixed (e.g. KPV: one oral + six injectable), the median
gravitates toward the majority form and treats the minority form
as an outlier-but-not-dropped contribution. This is acceptable
short-term and matches what a price-comparison user would
intuitively expect.

The risk surfaces if:

- A vendor flips form (capsule out of stock, vial back in) and the
  TWAP jumps unexplained.
- A new vendor enters a peptide's panel with the minority form,
  shifting the median.
- A consumer-facing chart shows the TWAP without explaining the
  per-form spread.

## Gating checklist for splitting a code

When a peptide's per-form pricing divergence consistently exceeds
~30% over 7 days, the operator may decide to split the peptide
into two codes (e.g. `DIHEXA` and `DIHEXAORAL`, or `KPV` and
`KPVORAL`). The gating checklist before splitting:

1. **Confirm the divergence is sustained, not transient.** Pull
   the 14-day per-vendor price history. The form premium must be
   visible across at least three separate weekly samples to count.
   A single-week spike is not enough.
2. **Confirm both forms have >=3 vendor coverage.** A split is
   only useful if both forms have enough vendors to produce a
   stable TWAP. If one form is single-vendor, leave it merged
   and let the median absorb it.
3. **Confirm the codes are pharmaceutically equivalent.** The
   split is about delivery form, not chemistry. If two forms have
   different absolute pharmacokinetics (oral DIHEXA vs injectable
   DIHEXA in vivo), document this in the description fields so
   verifiers know what the split represents.
4. **Then run the split migration.** Insert the new code at
   `is_active=true, enabled_in_twap=false`. Reassign the affected
   `supplier_products` rows to the new code. Wait 7 days for the
   per-form TWAP to stabilise. Flip `enabled_in_twap=true` per
   peptide.

Do not bypass any step.

## What to monitor

- `/v1/peptides/<code>/vendor-prices` for the three affected codes,
  weekly for the first 30 days after migration 0046 applies.
- The anomaly log at `/api/anomalies` for any `outlier_observation`
  events flagged on these codes.
- The deviation_from_median_bps metric per observation in the
  IPFS manifests, if a per-form spread exceeds 5000 bps that's
  worth investigating.

## Out of scope for this tracker

- Splitting a peptide into oral / injectable based on
  pharmacokinetic differences absent a pricing divergence.
- Form normalisation in the TWAP algorithm itself (would require
  a `filtered_median_v2` design pass).
- Per-vendor reliability scoring that down-weights minority-form
  observations.

These are all valid future work items but live in separate
trackers.
