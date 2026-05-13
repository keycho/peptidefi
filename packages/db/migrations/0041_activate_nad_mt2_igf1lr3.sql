-- 0041_activate_nad_mt2_igf1lr3.sql
-- Promote three peptides from observation phase to active TWAP pricing:
--
--   NAD       — Nicotinamide Adenine Dinucleotide
--   MT2       — Melanotan-II
--   IGF1LR3   — IGF-1 LR3
--
-- All three were seeded with peptides.enabled_in_twap=false in
-- migrations 0012 / 0038 and have since accumulated sufficient
-- vendor coverage to enter TWAP cohorts. Eligibility verified via
-- live API probe on api.biohash.network/v1/peptides/:code/price-
-- history?days=7 the day this migration was authored:
--
--   NAD      — 7 vendors, ~143 obs/vendor/7d, no integrity anomalies
--              cross-vendor median $0.119/mg (range $0.076–$0.479,
--              wide-but-expected for the per-format pricing spread)
--   MT2      — 7 vendors, ~143 obs/vendor/7d, no integrity anomalies
--              cross-vendor median $3.900/mg (PURERAWZ outlier at
--              $9.748 ≈ 2.5× — filtered_median_v1 will exclude)
--   IGF1LR3  — 6 vendors, ~167 obs/vendor/7d, no integrity anomalies
--              cross-vendor median $62.480/mg (GENETIC outlier at
--              $200 ≈ 3.2× — filtered_median_v1 will exclude)
--
-- All three pass the eligibility bar: ≥5 distinct active suppliers
-- in the last 7 days, median observation count per supplier ≥ 3,
-- no data-integrity anomalies (vendor_disagreement, oracle_commit_
-- failed) in the last 24h. Routine scrape_failed warns + the
-- peptide_onboarded info events from the scraper redeploy do not
-- block activation.
--
-- THREE PEPTIDES INTENTIONALLY NOT ACTIVATED:
--   TIRZEPATIDE  — only 2 vendors active in 7-day window (below 5)
--   RETATRUTIDE  — only 3 vendors active in 7-day window (below 5)
--   GHRP2        — only 3 vendors active in 7-day window (below 5)
--   Operator decision: stay in observation phase until the EZPEP +
--   OPTIPEP onboarding (migration 0040) settles and three more
--   vendors come online for these.
--
-- DEPLOY MECHANICS:
--   The worker's loadActivePeptides() filters on peptides.enabled_
--   in_twap. Within ~30 minutes (next TWAP window after this
--   migration applies) the worker will:
--     1. Include each newly-activated peptide in the per-cycle TWAP
--        computation
--     2. Write a peptide_twaps row + the on-chain twap_commit
--     3. Fire a peptide_promoted_to_twap anomaly event (info
--        severity) once per peptide via detectPeptidePromotions in
--        apps/worker/src/run.ts
--
-- METADATA:
--   Step 2 below seeds peptide_research_metadata rows for the three
--   peptides so /v1/research/:code returns the documented shape
--   immediately after activation. Content uses the same research-
--   grade language conventions as migration 0039 (no medical
--   claims, no dosage references, uniform research_disclaimer).
--
-- IDEMPOTENCY:
--   - UPDATE is a no-op when re-run after a successful apply.
--   - INSERT … ON CONFLICT (peptide_code) DO NOTHING for the
--     research metadata. Re-running is safe.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. Flip the activation flag. WHERE clause is conservative — only
-- the three peptides we've vetted, no batch promotion of unrelated
-- rows. If any of these codes no longer exist (highly unlikely; the
-- rows were created in migrations 0012 + 0038), the UPDATE is a
-- harmless no-op.
update public.peptides
   set enabled_in_twap = true
 where code in ('NAD', 'MT2', 'IGF1LR3');

-- 2. Seed peptide_research_metadata so the /v1/research/:code
-- endpoint returns content immediately. Format matches the round-1
-- entries from migration 0039. Three rows, idempotent via ON
-- CONFLICT.

-- ─── seed: NAD ────────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'NAD',
  'NAD+ (Nicotinamide Adenine Dinucleotide) is a coenzyme present in every living cell. It exists in oxidised (NAD+) and reduced (NADH) forms and participates in hundreds of redox reactions central to energy metabolism. The molecule is NOT a peptide in the strict sense — it is a dinucleotide of adenine and nicotinamide — but it is tracked alongside research peptides in many vendor catalogues because of overlapping research-protocol contexts (longevity, mitochondrial function, sirtuin biology).',
  'Studies suggest NAD+ acts as the substrate for NAD+-consuming enzymes including the sirtuins (NAD+-dependent deacylases), PARPs (poly-ADP-ribose polymerases), and CD38. NAD+ levels decline with age in mammalian tissues; the research literature has explored exogenous NAD+ + precursor administration as a route to restoring cellular NAD+ pools.',
  '["Mitochondrial-biology research", "Sirtuin biology and longevity-pathway research", "DNA-damage-response (PARP) studies", "Energy-metabolism / NAD+ supplementation models"]'::jsonb,
  'Half-life of exogenous NAD+ in the systemic circulation is short (minutes); most clinical and animal protocols use precursors (NMN, NR) rather than direct NAD+ administration. Comparative pharmacokinetics are an active research area.',
  'Lyophilised powder typically stored at -20°C, protected from light. NAD+ is hygroscopic and oxidation-sensitive; reconstituted solutions are typically kept refrigerated (2–8°C) and used promptly.',
  null,
  663.43,
  '["β-NAD+", "Nicotinamide Adenine Dinucleotide", "Coenzyme I", "Diphosphopyridine Nucleotide"]'::jsonb,
  'Nicotinamide Adenine Dinucleotide',
  100000
) on conflict (peptide_code) do nothing;

-- ─── seed: MT2 ────────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'MT2',
  'Melanotan-II is a synthetic cyclic heptapeptide analog of α-melanocyte-stimulating hormone (α-MSH). It has been extensively studied as a tool compound in melanocortin-receptor pharmacology; the cyclic conformation extends serum half-life and broadens receptor binding compared to the linear α-MSH backbone. The BioHash oracle tracks Melanotan-II as a research compound; the entry is concerned with structural, biochemical, and research-context information only.',
  'Research indicates Melanotan-II is a non-selective agonist at the melanocortin receptors MC1R, MC3R, MC4R, and MC5R. Animal and in-vitro studies have used the compound to probe MC4R signalling in feeding-circuit and sexual-behaviour models; MC1R activity drives the dermatologic effects studied in early human melanocortin research.',
  '["Melanocortin-receptor pharmacology research", "Animal feeding-circuit / hypothalamic studies", "Sexual-behaviour signalling research", "MC1R / pigmentation pathway studies"]'::jsonb,
  'Plasma half-life on the order of ~1.5 hours has been reported in early human pharmacokinetic studies; precise values vary by route of administration and protocol.',
  'Lyophilised powder typically stored at -20°C, protected from light. Reconstituted solutions are typically refrigerated (2–8°C); the cyclic disulfide-bridged structure tolerates reconstitution but degrades on repeated freeze/thaw cycles.',
  'Cyclic[Nle-Asp-His-DPhe-Arg-Trp-Lys]',
  1024.18,
  '["MT-II", "MT-2", "Melanotan II", "α-MSH analog"]'::jsonb,
  'Melanotan-II',
  600
) on conflict (peptide_code) do nothing;

-- ─── seed: IGF1LR3 ────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'IGF1LR3',
  'IGF-1 LR3 (Long Arg3 Insulin-like Growth Factor-1) is a synthetic 83-amino-acid analog of human IGF-1. Two engineered modifications — substitution of Arg for Glu at position 3 and an N-terminal 13-residue extension — together reduce its affinity for IGF-binding proteins (IGFBPs) and extend its in-vivo half-life. The BioHash oracle tracks IGF-1 LR3 as a research compound used in cell-biology and animal-model research contexts.',
  'Studies suggest IGF-1 LR3 binds the IGF-1 receptor (IGF1R) and activates the same PI3K/AKT and Ras/MAPK signalling pathways as native IGF-1. The reduced IGFBP-binding affinity is the principal pharmacological difference: more of the administered material remains "free" and bioavailable to engage IGF1R, which is the basis for its extended duration of action in animal-research protocols.',
  '["IGF-1 receptor signalling research", "Cell-culture growth-factor studies", "Muscle hypertrophy / hyperplasia animal-model research", "IGFBP-pharmacology research"]'::jsonb,
  'Half-life in animal studies has been reported in the ~20–30 hour range, substantially longer than native IGF-1 (~10 minutes free; ~12 hours when IGFBP-bound). The extension is attributed primarily to the reduced IGFBP affinity rather than the N-terminal extension per se.',
  'Lyophilised powder typically stored at -20°C, protected from light. Reconstitution typically uses bacteriostatic water or acidified saline; once in solution, refrigerated (2–8°C) and used within research-protocol stability windows. Avoid repeat freeze/thaw of reconstituted material.',
  null,
  9111.39,
  '["IGF-1 LR3", "LR3 IGF-1", "Long Arg3 IGF-1", "Long-Range IGF-1"]'::jsonb,
  'IGF-1 LR3 (Long Arg3 Insulin-like Growth Factor-1)',
  1000
) on conflict (peptide_code) do nothing;

-- ── verification (run manually after apply) ──────────────────────
--
--   -- All three activated, observation-phase set reduced to 3:
--   SELECT code, display_name, is_active, enabled_in_twap
--     FROM public.peptides
--    WHERE code IN ('NAD','MT2','IGF1LR3','TIRZEPATIDE','RETATRUTIDE','GHRP2')
--    ORDER BY enabled_in_twap, code;
--   -- expected:  3 active rows (NAD, MT2, IGF1LR3 — enabled_in_twap=true)
--   --           3 observation rows (TIRZEPATIDE, RETATRUTIDE, GHRP2 — false)
--
--   -- Research-metadata coverage now 5 round-1 + 3 = 8 entries:
--   SELECT peptide_code, length(overview) AS overview_len, full_name
--     FROM public.peptide_research_metadata
--    ORDER BY peptide_code;
--
--   -- First TWAP commits for the new peptides arrive within ~30 minutes
--   -- of migration apply (next worker cycle). Verify on the next tick:
--   SELECT peptide_code, status, twap_value, computed_at, solana_signature
--     FROM public.twap_commits
--    WHERE peptide_code IN ('NAD','MT2','IGF1LR3')
--      AND computed_at > now() - interval '1 hour'
--    ORDER BY peptide_code, computed_at DESC;
--
--   -- peptide_promoted_to_twap anomaly events (one per peptide):
--   SELECT peptide_id, event_type, occurred_at, description
--     FROM public.anomaly_events
--    WHERE event_type = 'peptide_promoted_to_twap'
--      AND peptide_id IN ('NAD','MT2','IGF1LR3')
--    ORDER BY occurred_at DESC;

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- update public.peptides
--    set enabled_in_twap = false
--  where code in ('NAD', 'MT2', 'IGF1LR3');
-- delete from public.peptide_research_metadata
--  where peptide_code in ('NAD', 'MT2', 'IGF1LR3');
-- commit;
