-- 0015_position_twap_audit_columns.sql
-- Audit trail for entry/exit TWAP rows.
--
-- The API stores entry_twap_usd_per_mg + exit_twap_usd_per_mg as decimals
-- on positions, but losing the link back to the exact peptide_twaps row
-- those came from makes incident triage painful — we'd have to fuzzy-join
-- on (peptide_id, opened_at) and could confuse adjacent rows when a worker
-- writes multiple cycles in the same second window.
--
-- This migration adds two nullable bigint FK columns. Both are populated
-- by the API (entry on open, exit on close); the DB does NOT enforce via
-- CHECK because it's a non-blocking audit column — the trade still lands
-- if for any reason we can't write the FK (e.g. peptide_twap row deleted
-- between read and insert). ON DELETE SET NULL keeps the position row
-- alive even if the parent TWAP row is later pruned.
--
-- Partial indexes because the columns are mostly null in the early state
-- of any position (entry is always set on insert; exit is only set after
-- close).

alter table public.positions
  add column entry_peptide_twap_id bigint
    references public.peptide_twaps(id) on delete set null,
  add column exit_peptide_twap_id  bigint
    references public.peptide_twaps(id) on delete set null;

create index positions_entry_twap_idx
  on public.positions (entry_peptide_twap_id)
  where entry_peptide_twap_id is not null;

create index positions_exit_twap_idx
  on public.positions (exit_peptide_twap_id)
  where exit_peptide_twap_id is not null;
