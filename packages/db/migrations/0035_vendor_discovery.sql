-- 0035_vendor_discovery.sql
-- Vendor lead submission + pipeline management. Five tables:
--   submitters         — community members participating in lead discovery
--   partner_vendors    — every vendor we track, in any pipeline state
--   vendor_leads       — submitter-originated lead records w/ bounty trail
--   submitter_violations — conduct breaches + clawbacks
--   bounty_payouts     — append-only audit trail of every BIO/USDC payout
--
-- Trust model:
--   - Public reads: submitter wallet+stats (via submitters_public view,
--     hides internal `notes` and `ban_reason`), the verified-tier subset
--     of partner_vendors, the bounty_payouts ledger (transparency), the
--     verified-vendor list. NOT the raw vendor_leads table — leads are
--     submitter-private and only the owner sees them via the wallet-
--     authenticated /api/leads/my-leads endpoint (app-layer auth, no
--     RLS user_id column to attach a SELF policy to since signers are
--     wallets, not Supabase auth.uid()s).
--   - Service-role writes: every mutation. The api service holds the
--     SUPABASE_SECRET_KEY and bypasses RLS for INSERT/UPDATE/DELETE.
--   - Append-only on bounty_payouts: only INSERT policy for service_role,
--     no UPDATE/DELETE policies. Same contract as `anomalies` (migration
--     0034). Once a payout is recorded it cannot be tampered with.
--
-- Circular FK note:
--   vendor_leads.vendor_id  → partner_vendors(id)
--   partner_vendors.source_lead_id → vendor_leads(id)
--   We create both tables first, then add the partner_vendors FK in a
--   separate ALTER (so the forward reference doesn't fail). Both are
--   nullable + DEFERRABLE INITIALLY DEFERRED so a future "create lead +
--   vendor row in one tx" pattern can land without ordering pain.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. submitters
create table if not exists public.submitters (
  id              bigserial primary key,
  wallet_address  text not null unique,
  registered_at   timestamptz not null default now(),
  status          text not null default 'active'
                  check (status in ('active', 'banned', 'suspended')),
  ban_reason      text,
  -- USDC-only payouts; no BIO column. $BIOHASH valuation makes
  -- token-denominated rewards meaningless ($0.19 at Tier 1) and
  -- including them in announcements reads as dishonest. Revisit
  -- after V0.2 staking ships and price discovery is utility-driven.
  total_paid_usdc numeric not null default 0,
  leads_submitted integer not null default 0,
  leads_accepted  integer not null default 0,
  leads_converted integer not null default 0,
  notes           text                                      -- internal-only
);

create index if not exists submitters_status_idx
  on public.submitters (status);

-- Public-safe view: drops ban_reason + notes so anon clients
-- can read leaderboard data without seeing internal flags.
create or replace view public.submitters_public as
  select
    id,
    wallet_address,
    registered_at,
    status,
    total_paid_usdc,
    leads_submitted,
    leads_accepted,
    leads_converted
  from public.submitters;

-- 2. partner_vendors (FK to vendor_leads added below after both exist)
create table if not exists public.partner_vendors (
  id              bigserial primary key,
  vendor_name     text not null unique,
  vendor_url      text not null,
  status          text not null
                  check (status in (
                    'in_pipeline',
                    'inquired',
                    'verified_listing',
                    'verified_feed',
                    'verified_reserve',
                    'declined',
                    'do_not_contact',
                    'banned'
                  )),
  origin          text not null
                  check (origin in ('community_lead', 'direct_team', 'inbound')),
  source_lead_id  bigint,                                   -- FK added below
  joined_at       timestamptz,
  removed_at      timestamptz,
  notes           text,                                     -- internal-only
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists partner_vendors_status_idx
  on public.partner_vendors (status);

-- 3. vendor_leads
create table if not exists public.vendor_leads (
  id                       bigserial primary key,
  submitter_id             bigint not null references public.submitters(id),
  vendor_name              text not null,
  vendor_url               text not null,
  vendor_url_hostname      text not null,
  reason_for_relevance     text not null,
  legitimacy_evidence      jsonb not null,
  suggested_tier           text
                            check (suggested_tier in (
                              'verified_listing',
                              'verified_feed',
                              'verified_reserve'
                            )),
  submitter_relationship   text not null
                            check (submitter_relationship in (
                              'customer',
                              'industry_contact',
                              'no_relationship',
                              'affiliated'
                            )),
  contact_suggestion       text,
  has_personal_contact     boolean not null default false,
  status                   text not null default 'submitted'
                            check (status in (
                              'submitted',
                              'rejected',
                              'accepted_pipeline',
                              'vendor_responded',
                              'vendor_verified',
                              'declined_by_vendor',
                              'expired'
                            )),
  rejection_reason         text,
  vendor_id                bigint
                            references public.partner_vendors(id)
                            deferrable initially deferred,
  -- Bounty trail (USDC-only). Tier 1 is recognition only — no
  -- payout — so we record the timestamp it was hit but no amount.
  tier1_recognised_at      timestamptz,
  tier2_paid_at            timestamptz,
  tier2_amount_usdc        numeric,
  tier3_paid_at            timestamptz,
  tier3_amount_usdc        numeric,
  intro_path_used          boolean not null default false,
  -- Lifecycle. responded_at is the entry timestamp for the
  -- vendor_responded state — the lead-expiry sweeper measures the
  -- 30-day "stalled after response" window from this stamp, not
  -- from accepted_at (which is too early). Set in /progress when
  -- milestone=vendor_responded; null for leads that never reach
  -- Tier 2.
  submitted_at             timestamptz not null default now(),
  reviewed_at              timestamptz,
  accepted_at              timestamptz,
  responded_at             timestamptz,
  converted_at             timestamptz,
  expired_at               timestamptz,
  notes                    text                              -- internal-only
);

-- Now add the deferred FK on partner_vendors → vendor_leads.
-- Wrapped in a do-block to ignore the ALTER if the constraint
-- already exists (re-running the migration must be safe).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'partner_vendors_source_lead_id_fkey'
  ) then
    alter table public.partner_vendors
      add constraint partner_vendors_source_lead_id_fkey
      foreign key (source_lead_id)
      references public.vendor_leads(id)
      deferrable initially deferred;
  end if;
end$$;

-- One active lead per vendor hostname. Re-submit allowed only
-- after the prior lead has reached a terminal state.
create unique index if not exists unique_active_lead_per_vendor
  on public.vendor_leads(vendor_url_hostname)
  where status in ('submitted', 'accepted_pipeline', 'vendor_responded');

create index if not exists vendor_leads_submitter_idx
  on public.vendor_leads (submitter_id);

create index if not exists vendor_leads_status_idx
  on public.vendor_leads (status);

create index if not exists vendor_leads_submitted_at_idx
  on public.vendor_leads (submitted_at desc);

-- 4. submitter_violations
create table if not exists public.submitter_violations (
  id                            bigserial primary key,
  submitter_id                  bigint not null references public.submitters(id),
  reported_by                   text,
  violation_type                text not null,
  details                       text not null,
  action_taken                  text not null
                                  check (action_taken in (
                                    'warning', 'suspend', 'ban', 'clawback'
                                  )),
  pending_clawback_amount_usdc  numeric,
  clawback_completed_at         timestamptz,
  reported_at                   timestamptz not null default now(),
  resolved_at                   timestamptz
);

create index if not exists submitter_violations_submitter_idx
  on public.submitter_violations (submitter_id);

-- 5. bounty_payouts (append-only)
-- Tier 1 is recognition only and does NOT generate a payout row;
-- the constraint enforces tier in (2, 3) so an accidental Tier 1
-- insert from a future caller fails fast at the DB. amount_usdc
-- is required (the only payable currency).
create table if not exists public.bounty_payouts (
  id                  bigserial primary key,
  submitter_id        bigint not null references public.submitters(id),
  lead_id             bigint not null references public.vendor_leads(id),
  tier                integer not null check (tier in (2, 3)),
  amount_usdc         numeric not null,
  intro_multiplier    numeric not null default 1.0,
  payout_tx_signature text,
  paid_at             timestamptz not null default now(),
  paid_by             text                                  -- 'auto' or admin name
);

create index if not exists bounty_payouts_submitter_idx
  on public.bounty_payouts (submitter_id);

create index if not exists bounty_payouts_lead_idx
  on public.bounty_payouts (lead_id);

create index if not exists bounty_payouts_paid_at_idx
  on public.bounty_payouts (paid_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────
-- See header for the trust model.

alter table public.submitters enable row level security;
alter table public.partner_vendors enable row level security;
alter table public.vendor_leads enable row level security;
alter table public.submitter_violations enable row level security;
alter table public.bounty_payouts enable row level security;
-- FORCE on the two tables that contain the most sensitive data:
-- partner_vendors (operator notes, declined-vendor list) and
-- bounty_payouts (treasury history). FORCE means even the table
-- owner can't bypass RLS — only service_role does (via grants).
alter table public.partner_vendors force row level security;
alter table public.bounty_payouts force row level security;

-- ── submitters: anon SEES via the public view, NOT the table ──────
-- Block direct table SELECT for anon — they get the view. Service
-- role gets full access via grants below.
drop policy if exists "submitters_select_public" on public.submitters;

-- ── partner_vendors: public SELECT only the verified tiers ───────
drop policy if exists "partner_vendors_select_verified" on public.partner_vendors;
create policy "partner_vendors_select_verified"
  on public.partner_vendors for select
  to anon, authenticated
  using (status in ('verified_listing', 'verified_feed', 'verified_reserve'));

-- ── vendor_leads: NO public read ──────────────────────────────────
-- Submitter-private. Owner reads via /api/leads/my-leads which uses
-- service_role under the hood, gated by wallet-signature auth at
-- the application layer. No RLS policy = deny-by-default for
-- anon/authenticated.

-- ── submitter_violations: NO public read ─────────────────────────
-- Internal only. Same deny-by-default pattern.

-- ── bounty_payouts: public SELECT (transparency) + service_role insert ──
drop policy if exists "bounty_payouts_select_public" on public.bounty_payouts;
create policy "bounty_payouts_select_public"
  on public.bounty_payouts for select
  to anon, authenticated using (true);

drop policy if exists "bounty_payouts_insert_service_role" on public.bounty_payouts;
create policy "bounty_payouts_insert_service_role"
  on public.bounty_payouts for insert
  to service_role with check (true);
-- No UPDATE / DELETE policy → append-only for every role.

-- ── Grants ────────────────────────────────────────────────────────
-- service_role gets full access on every table (it bypasses RLS via
-- the secret-key client). anon + authenticated get column-level
-- SELECT on the safe view + the verified-vendor subset.

grant select on public.submitters_public to anon, authenticated;
grant select on public.partner_vendors  to anon, authenticated;
grant select on public.bounty_payouts   to anon, authenticated;

grant insert, select, update on public.submitters            to service_role;
grant insert, select, update on public.partner_vendors       to service_role;
grant insert, select, update on public.vendor_leads          to service_role;
grant insert, select, update on public.submitter_violations  to service_role;
grant insert, select          on public.bounty_payouts       to service_role;

grant usage, select on sequence public.submitters_id_seq            to service_role;
grant usage, select on sequence public.partner_vendors_id_seq       to service_role;
grant usage, select on sequence public.vendor_leads_id_seq          to service_role;
grant usage, select on sequence public.submitter_violations_id_seq  to service_role;
grant usage, select on sequence public.bounty_payouts_id_seq        to service_role;

comment on table public.submitters        is 'Community lead-discovery participants. notes/ban_reason internal only — read via submitters_public view.';
comment on table public.partner_vendors   is 'Pipeline of every vendor BioHash tracks. Public read restricted to verified_* tiers via RLS.';
comment on table public.vendor_leads      is 'Submitter-originated lead records. NO public read — owner gets own via /api/leads/my-leads (wallet-sig auth).';
comment on table public.bounty_payouts    is 'Append-only payout ledger. Public read for transparency; INSERT only by service_role; no UPDATE/DELETE policy.';

-- ── verification (run manually after apply) ──────────────────────
--   -- Should fail (no UPDATE policy on bounty_payouts):
--   update public.bounty_payouts set amount_usdc = 0 where id = 1;
--   -- Should fail (no DELETE policy):
--   delete from public.bounty_payouts where id = 1;
--   -- Should fail (anon reads vendor_leads — no policy at all):
--   set role anon; select count(*) from public.vendor_leads;
--   reset role;
--   -- Should succeed (anon reads via the public view):
--   set role anon; select count(*) from public.submitters_public;
--   reset role;

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- drop policy if exists "bounty_payouts_insert_service_role" on public.bounty_payouts;
-- drop policy if exists "bounty_payouts_select_public"       on public.bounty_payouts;
-- drop policy if exists "partner_vendors_select_verified"    on public.partner_vendors;
-- alter table public.bounty_payouts disable row level security;
-- alter table public.submitter_violations disable row level security;
-- alter table public.vendor_leads disable row level security;
-- alter table public.partner_vendors disable row level security;
-- alter table public.submitters disable row level security;
-- drop view if exists public.submitters_public;
-- drop table if exists public.bounty_payouts;
-- drop table if exists public.submitter_violations;
-- alter table public.vendor_leads drop constraint if exists vendor_leads_vendor_id_fkey;
-- alter table public.partner_vendors drop constraint if exists partner_vendors_source_lead_id_fkey;
-- drop table if exists public.vendor_leads;
-- drop table if exists public.partner_vendors;
-- drop table if exists public.submitters;
-- commit;
