-- 0045_drop_index_history_hour_truncation_check.sql
-- Drops the CHECK constraint that wrongly assumed twap_commits.computed_at
-- is hour-truncated.
--
-- Migration 0043 added `index_history.hour_start timestamptz PRIMARY KEY`
-- plus a CHECK constraint enforcing `date_trunc('hour', hour_start) =
-- hour_start`. The intent was to guarantee at the storage layer that
-- index_history rows are keyed by the same canonical hour identifier
-- as `twap_commits.computed_at`.
--
-- The assumption was wrong. The oracle's worker writes
-- `twap_commits.computed_at` at the CLOSE of the observation window,
-- typically HH:59:00 UTC, not at the hour boundary HH:00:00. The
-- truncation CHECK therefore rejects every insert the cohort-completion
-- runner attempts, since the runner uses the cohort's shared
-- computed_at as the hour_start value (the whole point of the
-- timestamptz key was to avoid an epoch-seconds conversion at the
-- boundary, see 0043's design note).
--
-- The PK itself is correct: hour_start is the canonical identifier
-- for "the index level for this observation window", and the unique
-- index it implies is what we actually rely on for the "one row per
-- window" invariant and the ON CONFLICT (hour_start) DO NOTHING
-- mutex in the runner.
--
-- This migration is ADDITIVE-OVER-SUBTRACTIVE: it does not touch the
-- column, the PK, or any other constraint added in 0043. It only
-- drops the offending CHECK and updates the column comment to reflect
-- the actual semantics.
--
-- Once this migration is applied, on the next oracle restart the
-- startup recovery (apps/oracle/src/index-history-runner.ts
-- runStartupRecovery) re-fires unconditionally and processes the
-- backlog of complete-cohort hours that 0043's CHECK prevented from
-- landing.
--
-- Reversible. Down block at the bottom re-adds the CHECK (but the
-- CHECK is incorrect; rollback should only happen if 0043's design
-- assumption gets revisited — at which point the worker's
-- computed_at semantics would also need to change).

-- == up ============================================================

alter table public.index_history
  drop constraint if exists index_history_hour_start_truncated;

comment on column public.index_history.hour_start is
  'Identifier for the hour this index level was computed for. Matches twap_commits.computed_at, which is the close-of-window timestamp (typically HH:59:00 UTC). PK uniqueness enforces one-row-per-hour-window. The original truncation invariant from migration 0043 was based on an incorrect assumption about computed_at semantics and was dropped in 0045.';

-- == down (reversal block, run only on rollback) ===================
-- begin;
-- alter table public.index_history
--   add constraint index_history_hour_start_truncated
--   check (date_trunc('hour', hour_start) = hour_start);
-- commit;
