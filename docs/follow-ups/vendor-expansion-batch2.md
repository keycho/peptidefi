Vendor expansion batch 2

Roadmap for the next vendor expansion session. This document captures
which Strategy-A candidates from the original 10-vendor batch were
deferred during the 2026-05-18 recon, why, and what would unblock each
one for a future session.

Batch 1 outcome: 1 vendor onboarded (Prime Peptides via migration 0047).
9 deferred. Active panel count moves from 12 to 13. Below batch 1's
realistic floor (6-9), driven by anti-scraping posture across the
candidate set.

Why batch 2 exists

The operator-set criteria established in docs/follow-ups/vendor-expansion.md
(ruo.bio precedent) require:

- Public pricing visible without account.
- No explicit anti-scraping language in robots.txt or ToS.
- No paywall on the catalog endpoint.
- No history of legal enforcement.

Six of the original ten candidates fail at least one of these
criteria. Three are technically blocked at the network layer
(Cloudflare). One is mis-identified (a lab-equipment vendor, not a
research-peptide retailer). The remaining three have data-quality
issues that need hand-curation rather than the existing WC catalog
factory flow.

Deferred candidates by category

Category A: account-required UX, scraper would work but ethics fail

  Mile High Compounds (https://milehighcompounds.is)
    Probe 2026-05-18:
      - homepage redirects to /research-access/?redirect_to=...
      - The gate page presents an account-registration form with
        "Create Account" button, "Email or Username / Password",
        "I confirm I am 21 years of age or older", and "By creating
        an account you agree to our Terms & Conditions".
      - WC API at /wp-json/wc/store/v1/products returns JSON publicly
        (catalog reachable without auth).
      - 30 of our 46 tracked peptide codes have clean single-vial
        single-molecule matches (the highest in the batch).
    Verdict: defer. The unauthenticated catalog API exists but the
    vendor's signalled posture is "account required to view prices",
    matching the ruo.bio criterion. Adding them would mean knowingly
    bypassing a user-facing gate.
    Unblock: explicit operator + counsel review of vendor ToS. If
    counsel concludes the public WC API is fair game despite the UX
    gate, migration is straightforward (WC catalog already mapped,
    14 SKU rows ready to land).

  Felix Chem (https://felixchem.is)
    Probe 2026-05-18:
      - All product URLs redirect to /felix-chemical-supply/.
      - The gate page loads a user_registration_params bundle with
        email verification flow ("user_email_pending":"User
        registered. Verify your email by clicking on the link sent
        to your email."), "user_under_approval" (admin-approval
        registration), and account-deletion controls. Account
        creation is mandatory and gated on admin approval.
      - robots.txt has User-agent: GPTBot \n Disallow: / (explicit
        anti-automation directive - soft signal but clear).
      - WC API at /wp-json/wc/store/v1/products returns JSON publicly.
      - 19 clean single-vial matches.
    Verdict: defer. Stronger signal than Mile High: admin-approval
    registration + explicit robots.txt directive against an
    automation user-agent. Closer to ruo.bio territory.
    Unblock: only if counsel signs off on the ToS reading, AND only
    with a separate-IP-pool / proxy strategy that respects the
    GPTBot directive's spirit (i.e. don't pretend to be a search-
    engine crawler).

Category B: Cloudflare-blocked at network layer

  Modern Aminos (https://modernaminos.com)
    Status: already in the codebase as suppliers.status='paused'
    per a prior recon ("Cloudflare anti-bot beats ScrapingAnt's
    standard tier"). 2026-05-18 probe: homepage 403, WC API 403.
    Verdict: defer. Same blocker as the existing pause reason.
    Unblock: an upgraded proxy tier (Bright Data residential,
    ScrapingAnt premium, IPRoyal) that consistently solves
    Cloudflare's Turnstile challenges. Cost trade-off needs
    operator sign-off.

  True Peptide (https://truepeptidelabs.com)
    Status: 2026-05-18 probe returns "Just a moment..." Cloudflare
    interstitial on both homepage and WC API endpoint.
    Verdict: defer. Same as Modern Aminos.
    Unblock: same as Modern Aminos.

  Ascension Peptides (https://ascensionpeptides.com)
    Status: 2026-05-18 probe returns Cloudflare 403 on both
    homepage and WC API endpoint.
    Verdict: defer. Same.
    Unblock: same.

Category C: wrong vendor identity

  AMC Essentials (https://amc-essentials.com)
    Probe 2026-05-18:
      - Catalog contains peptide-lab equipment as headline items: a
        SYMPHONY X Parallel Peptide Synthesizer (quote-on-request,
        listed at $0), a UV-Visible Spectrophotometer ($6595), a
        Filtered Ductless Desiccation Storage Cabinet ($4495).
      - Research-peptide products do exist but are heavily mixed
        with " / " dual-molecule blends ("Epithalon / Pinealon
        (50mg)", "Mito / MOTSc 65mg", "PE 22-28 / Selank / Semax
        30mg") and "FREE GIFT" promotional SKUs without stable
        pricing.
      - After strict single-molecule single-vial filtering the
        clean subset is ~5-8 SKUs, not enough to justify the
        operational overhead of treating AMC as a retail peptide
        vendor.
    Verdict: drop from the expansion list. AMC's primary market is
    peptide-synthesis lab equipment for research institutions, not
    a consumer-style research-peptide retailer comparable to
    PUREHEALTH or GENETIC. The catalog isn't shaped right for our
    pricing model.
    Unblock: not recommended unless we expand the data model to
    handle dual-molecule blends as first-class entities, at which
    point AMC's blend SKUs would have a home.

Category D: workable but require hand-curated SKU lists

  Polaris Peptides (https://polarispeptides.com)
    Probe: WC API public, ~61 products. Filter passes 28 codes but
    several map to blend products (GLOW 50 mixes for BPC157,
    Cagrilintide+Semaglutide mix for GLP1). Per-SKU hand-selection
    needed to avoid blend leakage.
    Verdict: defer. The cost is per-SKU verification, not technical.
    Unblock: one session of manual SKU review against Polaris's
    full catalog, picking the canonical single-molecule single-vial
    product for each code. Estimated 1-2 hours operator time.

  Paramount Peptides (https://paramountpeptides.com)
    Probe: WC API public, ~146 products. 33 codes match raw, ~29
    after strict filter. Catalog leans heavily on tablets/capsules
    ("BPC-157 (1mg) x 60 Tablets", "MK-677 (25mg) x 60 Tablets",
    "5-Amino-1MQ (50mg) x 60 Tablets"), an oral form that drifts
    from the injectable vial baseline in the existing 32-peptide
    panel and amplifies the heterogeneity already tracked in
    docs/follow-ups/oral-vs-injectable-form-split.md.
    Verdict: defer. Same hand-curation step plus a decision about
    whether Paramount's tablet SKUs should join as oral-variant
    peptide codes (KPVORAL etc.) or be skipped entirely.
    Unblock: operator decision on the oral-vs-injectable form
    question (per the existing tracker) AND a per-SKU vial-only
    pass through Paramount's catalog.

  Solution Peptides (https://solutionpeptides.net)
    Probe: homepage Cloudflare 403, but WC API responds JSON
    publicly. Catalog has 219 products of which ~33 match tracked
    codes. The match set is dominated by "10 VIAL COMBO PACK"
    SKUs where price covers 10 vials but the mg shown is per-vial;
    the existing scraper does price/mass and would understate
    per-mg pricing by 10x. Single-vial counterparts exist for some
    peptides at older product IDs (Tesamorelin 20mg, Semax 30mg,
    Epithalon 50mg) but require manual SKU pinning.
    Verdict: defer. Schema doesn't fit combo-pack pricing without
    schema work or hand-pinning single-vial IDs.
    Unblock: one session of manual single-vial SKU mapping AND
    operator confirmation that the homepage CF 403 doesn't escalate
    to API-level blocking later. Or schema work to model bulk
    multi-vial packs as a distinct unit type.

What to do for batch 2

1. Operator decisions needed before batch 2 begins:
   a. Counsel review of Mile High and Felix Chem ToS - adoptable or
      drop.
   b. Proxy tier upgrade decision for the three Cloudflare-blocked
      vendors. If yes, the recon for Modern Aminos / True Peptide /
      Ascension reruns under the new proxy.
   c. Decision on whether Paramount's tablet-form SKUs are in
      scope, per the oral-vs-injectable form-split tracker.
   d. Drop AMC Essentials from the candidate list.

2. If (a) clears Mile High and Felix Chem, batch 2 adds ~30 + 19 =
   49 supplier_products rows across 2 vendors with no further work
   (catalogs already mapped, migration ready to template from 0047).

3. If (c) clears Paramount and (b) does not deliver a usable proxy,
   batch 2 also covers a hand-curated Polaris + Paramount pass.
   Solution stays deferred until schema work for multi-vial packs
   lands.

4. Realistic upper bound for batch 2: +5 vendors (Mile High,
   Felix Chem, Polaris, Paramount, plus one of the three Cloudflare-
   blocked vendors if a proxy upgrade lands). That would put the
   panel at 18 vendors, still short of the original 22 target. The
   final 4 require a different category of work (proxy tier, ToS
   counsel review, or schema extension).

Reference

- Batch 1 migration: packages/db/migrations/0047_add_prime_peptides.sql
- Batch 1 registration: apps/scraper/src/suppliers/index.ts (PRIME line)
- Existing tracker: docs/follow-ups/vendor-expansion.md (LIMITLESS,
  PARTICLE). On the unmerged feat/scraper-peptide-expansion branch as
  of 2026-05-18; will be on main once that branch merges.
- Form-split tracker: docs/follow-ups/oral-vs-injectable-form-split.md
  (also unmerged on the same branch).
