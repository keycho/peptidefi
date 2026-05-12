-- 0039_peptide_research_metadata.sql
-- Curated scientific metadata for the BioHash Peptide Research Index.
-- One row per peptide that should appear under /research/<CODE>; the
-- absence of a row is the canonical signal that a peptide is not
-- (yet) indexed for the research surface — the /v1/research/:code
-- endpoint 404s on missing rows so the index can grow incrementally
-- without leaking half-curated entries.
--
-- SCOPE: round-1 launch covers 5 peptides — BPC157, TB500, GHKCU,
-- GLP1, TIRZEPATIDE. Codes verified to exist in the peptides table
-- (BPC157+TB500 from 0002; GHKCU from 0012; GLP1 from 0002; TIRZE
-- PATIDE from 0019, activated in 0038).
--
-- CONTENT POLICY:
--   - Research-grade language only ("studies suggest", "investigated
--     for its role in"). No medical claims, no dosage references,
--     no human-use recommendations.
--   - Semaglutide and Tirzepatide entries are framed entirely as
--     research compounds (these are prescription drugs in regulated
--     markets — the BioHash oracle tracks them as research peptides
--     and the metadata reflects that exclusive framing).
--   - research_disclaimer column carries a uniform legal-protective
--     line; surfaced verbatim by the API.
--
-- The seed uses INSERT … ON CONFLICT (peptide_code) DO NOTHING so
-- re-applying this migration is idempotent. To revise curated
-- content, write a follow-up migration that UPDATEs the affected
-- row rather than editing this file post-deploy.

create table if not exists public.peptide_research_metadata (
  peptide_code text primary key references public.peptides(code) on update cascade on delete cascade,
  overview text not null,
  mechanism text,
  applications jsonb,
  half_life_estimate text,
  storage text,
  sequence text,
  molecular_weight numeric,
  aliases jsonb,
  full_name text,
  pubmed_citation_count_estimate integer,
  research_disclaimer text not null default 'For research and informational purposes only. Not medical advice. Not for human consumption unless prescribed by a licensed physician.',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists peptide_research_metadata_updated_at_idx
  on public.peptide_research_metadata (updated_at desc);

-- ─── seed: BPC-157 ─────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'BPC157',
  'BPC-157 (Body Protection Compound 157) is a synthetic 15-amino-acid peptide derived from a sequence identified in human gastric juice. Preclinical research has extensively investigated its role in tissue repair processes, with rodent studies suggesting effects on tendon, ligament, muscle, and gastrointestinal models. Most published research is from a small number of laboratories, and human clinical data remains limited.',
  'Studies suggest BPC-157 may interact with the nitric oxide (NO) signaling pathway and modulate growth-factor receptor expression (notably VEGFR2 and FAK-paxillin signaling) in injury models. The exact receptor target has not been definitively identified in the published literature.',
  '["Tendon and ligament repair research", "Gastrointestinal mucosal research", "Vascular and angiogenesis models", "Soft-tissue injury research"]'::jsonb,
  'Half-life in rodent serum has been reported in the ~30 minute range following parenteral administration in the research literature; human pharmacokinetic data is not well established.',
  'Lyophilized powder typically stored at -20°C. Once reconstituted in bacteriostatic water, refrigeration (2–8°C) and use within ~14 days is common in research protocols.',
  'GEPPPGKPADDAGLV',
  1419.53,
  '["Body Protection Compound 157", "BPC 157", "PL 14736 (pentadecapeptide BPC-157)"]'::jsonb,
  'Body Protection Compound 157',
  400
) on conflict (peptide_code) do nothing;

-- ─── seed: TB-500 ──────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'TB500',
  'TB-500 refers to an active fragment derived from Thymosin Beta-4 (TB-4), a naturally occurring 43-amino-acid actin-binding peptide. In preclinical research, TB-4 has been studied for its role in cell migration, actin polymerization dynamics, and wound-healing models. TB-500 is commonly studied as a synthetic surrogate in research contexts, often alongside BPC-157 in tissue-repair literature.',
  'Research indicates Thymosin Beta-4 binds G-actin and is a major regulator of actin sequestration in cells. Its proposed role in migration, angiogenesis, and inflammation modulation is supported by in-vitro and animal-model studies.',
  '["Wound healing research", "Cardiac tissue repair models", "Corneal injury research", "Actin dynamics studies"]'::jsonb,
  'Half-life estimates from rodent pharmacokinetic studies of thymosin beta-4 have been reported on the order of hours; data for the TB-500 fragment specifically is less well characterized.',
  'Lyophilized powder typically stored at -20°C. Once reconstituted, refrigeration (2–8°C) and use within ~14 days is common in research protocols.',
  'LKKTETQ',
  889.04,
  '["Thymosin Beta-4 Fragment", "Tβ4 Fragment", "TB4"]'::jsonb,
  'Thymosin Beta-4 Fragment',
  900
) on conflict (peptide_code) do nothing;

-- ─── seed: GHK-Cu ──────────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'GHKCU',
  'GHK-Cu is a tripeptide-copper complex (glycyl-L-histidyl-L-lysine bound to copper(II)) that occurs naturally in human plasma. It has been extensively investigated in dermatological and wound-healing research, with studies suggesting effects on extracellular matrix remodeling and antioxidant defense in cell-culture and animal models. Of the five round-1 entries, GHK-Cu has the longest publication history.',
  'Studies suggest the tripeptide''s copper-binding domain participates in oxidation-reduction chemistry at sites of tissue stress. In-vitro work has reported effects on fibroblast gene expression, collagen synthesis, and metalloproteinase activity.',
  '["Skin biology and cosmetic research", "Wound and burn healing models", "Hair-follicle and dermal-papilla research", "Antioxidant and gene-expression studies"]'::jsonb,
  'Plasma levels of endogenous GHK decline with age in healthy adults; clearance pharmacokinetics for exogenous GHK-Cu in humans are not well characterized in the open literature.',
  'Lyophilized powder typically stored at -20°C, protected from light. Reconstituted solutions are typically kept refrigerated (2–8°C); copper-peptide solutions can be sensitive to oxidation and light exposure.',
  'GHK',
  340.42,
  '["Copper Peptide", "GHK Copper", "Glycyl-Histidyl-Lysine Copper", "Tripeptide-1 Copper"]'::jsonb,
  'Glycyl-L-Histidyl-L-Lysine Copper Complex',
  600
) on conflict (peptide_code) do nothing;

-- ─── seed: GLP1 (Semaglutide / GLP-1 receptor agonists) ────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'GLP1',
  'GLP-1 (Glucagon-Like Peptide 1) is an incretin hormone whose active fragment is investigated for its role in glucose homeostasis and energy-balance research. The BioHash oracle tracks the GLP-1 peptide class as a research compound; semaglutide is the most commonly indexed analog in this class. As a research compound in the BioHash index, this entry is concerned exclusively with structural, biochemical, and research-context information — not clinical use, dosing, or off-label application.',
  'GLP-1 receptor agonists bind the GLP-1 receptor (GLP1R), a class B G-protein-coupled receptor expressed in pancreatic β-cells and across the central nervous system. Research has investigated downstream effects on insulin and glucagon secretion, gastric emptying, and hypothalamic feeding-related circuits.',
  '["Incretin pharmacology research", "Glucose homeostasis models", "Hypothalamic feeding-circuit studies", "Receptor-pharmacology and analog SAR research"]'::jsonb,
  'Half-life depends heavily on the specific analog under study. Native GLP-1(7–36) amide has a serum half-life in the ~1–2 minute range in human studies; long-acting analogs designed for once-weekly research models extend this dramatically.',
  'Lyophilized powder typically stored at -20°C. Reconstituted solutions are typically refrigerated (2–8°C); peptide stability varies by analog and reconstitution buffer.',
  'HAEGTFTSDVSSYLEGQAAKEFIAWLVRGRG',
  3297.7,
  '["Glucagon-Like Peptide-1", "Semaglutide (analog)", "GLP-1(7–36) amide (reference fragment)", "GLP-1 receptor agonist"]'::jsonb,
  'Glucagon-Like Peptide 1 (research class — includes semaglutide-type analogs)',
  20000
) on conflict (peptide_code) do nothing;

-- ─── seed: TIRZEPATIDE ─────────────────────────────────────────────
insert into public.peptide_research_metadata (
  peptide_code, overview, mechanism, applications, half_life_estimate,
  storage, sequence, molecular_weight, aliases, full_name,
  pubmed_citation_count_estimate
) values (
  'TIRZEPATIDE',
  'Tirzepatide is a synthetic peptide investigated as a dual agonist of the glucose-dependent insulinotropic polypeptide (GIP) receptor and the GLP-1 receptor. In the published research literature it has been studied as a tool compound for examining the pharmacology of dual incretin signaling in metabolic-research models. The BioHash oracle tracks tirzepatide exclusively as a research compound; this entry is concerned with structural, biochemical, and research-context information only.',
  'Tirzepatide is a 39-amino-acid peptide engineered with a C20 fatty di-acid moiety for albumin binding, which extends its in-vivo half-life relative to native incretin peptides. Research indicates simultaneous engagement of GIP and GLP-1 receptors, with downstream effects on insulin secretion and central feeding circuits investigated in animal models.',
  '["Dual incretin receptor pharmacology research", "Metabolic-disease animal models", "Receptor-binding and SAR studies", "Peptide engineering / albumin-binding fatty-acid conjugation research"]'::jsonb,
  'Approximate elimination half-life reported in human pharmacokinetic studies is on the order of ~5 days, attributed to the engineered fatty-acid albumin-binding modification.',
  'Lyophilized powder typically stored at -20°C, protected from light. Reconstituted solutions are typically refrigerated (2–8°C); use within research-protocol stability windows.',
  null,
  4813.45,
  '["LY3298176", "Dual GIP/GLP-1 receptor agonist"]'::jsonb,
  'Tirzepatide (LY3298176) — dual GIP/GLP-1 receptor agonist (research compound)',
  500
) on conflict (peptide_code) do nothing;

-- ─── audit trail ──────────────────────────────────────────────────
-- Five rows seeded above. Verify after applying:
--
--   select peptide_code, length(overview) from public.peptide_research_metadata;
--
-- Expected: 5 rows, overview length > 0 for each.
