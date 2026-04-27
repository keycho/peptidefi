-- 0013_twap_worker_simplification.sql
-- Adapt peptide_twaps for the simplified worker design:
--
--   The original Phase A spec aggregated supplier-level TWAPs (computed from
--   multiple observations per supplier) into a peptide-level median. The
--   simplified worker takes the most-recent successful supplier_observation
--   per supplier inside a 5-minute window and medians those directly,
--   skipping the supplier_twaps middle layer.
--
--   Three schema changes to support the simpler flow:
--     1. twap_usd_per_mg becomes NULLable so we can write "audit" rows when
--        a peptide has fewer than 2 reporting suppliers in the window
--        (honest no-data signal instead of a single-supplier fake-TWAP).
--     2. input_supplier_twap_ids gets a default '{}' so simplified-flow
--        callers can omit it when not using the supplier_twaps layer.
--     3. New input_observation_ids / dropped_observation_ids arrays so the
--        simplified flow can record exactly which supplier_observations
--        contributed to each peptide_twap (audit trail + ability to replay).
--
-- The supplier_twaps table is untouched. If we later reactivate per-supplier
-- TWAP smoothing, that flow can populate input_supplier_twap_ids again.

alter table public.peptide_twaps
  alter column twap_usd_per_mg drop not null;

alter table public.peptide_twaps
  alter column input_supplier_twap_ids set default '{}';

alter table public.peptide_twaps
  add column if not exists input_observation_ids   bigint[] not null default '{}';

alter table public.peptide_twaps
  add column if not exists dropped_observation_ids bigint[] not null default '{}';

-- A diagnostic CHECK so we can never write a "twap=NULL but suppliers_used>0" row.
-- Either we have a TWAP (twap is non-null) and a positive supplier count,
-- or we acknowledge thin data (twap null, suppliers_used can be 0 or 1).
alter table public.peptide_twaps
  add constraint peptide_twaps_twap_consistency check (
    (twap_usd_per_mg is not null and suppliers_used >= 1)
    or
    (twap_usd_per_mg is null and suppliers_used <= 1)
  );
