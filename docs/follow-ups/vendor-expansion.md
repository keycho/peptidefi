# Vendor expansion follow-up

Status: blocked. Both LIMITLESS and PARTICLE are blocked pending
recon-note recovery and host verification. This doc tracks the
checklist required before either vendor can be unblocked, and
documents what to do once unblocked.

## Why blocked

The deferred-vendor list in `apps/scraper/src/suppliers/index.ts`
mentions:

> Tier 2 (deferred): LIMITLESS (BigCommerce HTML scrape) and
> PARTICLE (PrestaShop HTML scrape). Both confirmed scrapable via
> cheerio during recon but need per-platform parsers; deferred
> until needed.

The recon notes live on the `peptide-oracle-pivot` branch, which is
no longer present in this repo's git history. The current repo has
no canonical host (URL) recorded for either vendor.

For LIMITLESS specifically: at least three commercially active
research peptide vendors use "limitless" in their name
(limitlesslifenutra.com, limitlesspep.com, limitlesspeptides.com).
Building a scraper against the wrong one would either target a
vendor that was deliberately rejected during recon, or effectively
add a new unvetted vendor to the cohort.

For PARTICLE: same ambiguity class.

## Unblock checklist (apply per vendor before re-opening the work)

1. **Locate or reconstruct the original recon notes.** Check git
   reflog, stashes, local backups, the operator's external notes
   (Notion / Drive / Slack scrollback). The recon record should
   name the exact host that was evaluated.
2. **Verify the target host's current platform via curl + HTML
   inspection.** The "BigCommerce" / "PrestaShop" tags in the
   `suppliers/index.ts` comment may be stale; sites do migrate
   platforms. Inspect the HTML for platform fingerprints (Stencil
   theme markers, PrestaShop CSS/JS handles, Shopify storefront
   API headers, etc.) before writing a parser.
3. **Verify the target's robots.txt and ToS posture.** Pull
   `https://<host>/robots.txt` and read the ToS. Confirm:
   - Public pricing visible without account.
   - No explicit anti-scraping language.
   - No paywall on the catalog endpoint.
   - No history of enforcement.
   The ruo.bio precedent (liquidated damages, account-only
   pricing, lifetime blacklist) is the reference for "too hot to
   touch".
4. **Then return to parser implementation.** Write the per-
   platform scraper module under `apps/scraper/src/suppliers/`,
   register in the SUPPLIERS map, seed `public.suppliers` and
   `public.supplier_products` rows via a new migration. Follow
   the migration-0036 pattern (status='active',
   enabled_in_twap=false until quality review).

## Implementation notes when unblocked

### LIMITLESS

- Platform per existing comment: BigCommerce. Verify per item 2 above.
- BigCommerce Stencil sites typically expose:
  - JSON-LD product schema in the page HTML.
  - `/api/storefront/products` endpoint (auth required for some).
  - Plain HTML product pages parseable with cheerio.
- Parser approach: extract from JSON-LD where available; fall back
  to HTML selectors on price + availability.
- Pack-size parsing: BigCommerce variants may not be exposed as
  query params; need to inspect the catalog page or product
  detail HTML for the size selector.

### PARTICLE

- Platform per existing comment: PrestaShop. Verify per item 2 above.
- PrestaShop sites typically expose:
  - Microdata / schema.org product markup.
  - `/index.php?controller=product&id_product=<n>` endpoints.
  - Combination (variant) selection via JS - may need Playwright
    if pack sizes are JS-loaded.
- Parser approach: HTML scrape with cheerio first; escalate to
  Playwright (mark `needsBrowser: true`) only if variants require
  JS to render.

## Acceptance gate for either vendor

When the unblock checklist is complete and the parser is written:

- `pnpm --filter @peptide-oracle/scraper typecheck` clean.
- New scraper module covered by unit tests under
  `apps/scraper/src/__tests__/` using captured fixture HTML.
- Migration adds vendor row at `status='active', enabled_in_twap=false`.
- 7-day quality-review window with `enabled_in_twap=false` per
  the established pattern.
- Operator review of the migration before merge.

Do not bypass any step.
