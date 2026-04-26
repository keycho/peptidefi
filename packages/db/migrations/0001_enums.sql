-- 0001_enums.sql
-- All custom enum types used across the schema.
-- Created first because later tables reference these.

create type public.availability_tier as enum (
  'in_stock',
  'low_stock',
  'lead_time',
  'out_of_stock',
  'discontinued',
  'unknown'
);

create type public.peptide_status as enum (
  'active',
  'paused',
  'delisted'
);

create type public.supplier_status as enum (
  'active',
  'paused',
  'removed'
);

create type public.event_type as enum (
  'availability_change',
  'price_spike',
  'price_crash',
  'listing_added',
  'listing_removed'
);

create type public.prediction_market_type as enum (
  'binary',
  'scalar'
);

create type public.resolution_tier as enum (
  'tier1_auto',
  'tier3_manual'
);

create type public.prediction_market_state as enum (
  'pending',
  'open',
  'locked',
  'resolved',
  'invalid'
);

create type public.vault_status as enum (
  'pending',
  'open',
  'closed',
  'liquidated'
);
