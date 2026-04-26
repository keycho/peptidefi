export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      amm_pools: {
        Row: {
          created_at: string
          event_fee_active_until: string | null
          fee_bps: number
          id: number
          last_oracle_check_at: string
          last_oracle_price_micro: number
          peptide_id: number
          peptide_reserve: number
          points_reserve: number
          slippage_curve_kind: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_fee_active_until?: string | null
          fee_bps?: number
          id?: number
          last_oracle_check_at: string
          last_oracle_price_micro: number
          peptide_id: number
          peptide_reserve: number
          points_reserve: number
          slippage_curve_kind?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_fee_active_until?: string | null
          fee_bps?: number
          id?: number
          last_oracle_check_at?: string
          last_oracle_price_micro?: number
          peptide_id?: number
          peptide_reserve?: number
          points_reserve?: number
          slippage_curve_kind?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "amm_pools_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: true
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
        ]
      }
      amm_trades: {
        Row: {
          created_at: string
          direction: string
          fee_paid_points: number
          id: number
          oracle_price_micro_at_trade: number
          peptide_id: number
          peptide_in: number | null
          peptide_out: number | null
          points_in: number | null
          points_out: number | null
          pool_id: number
          pool_price_after: number
          user_id: string
        }
        Insert: {
          created_at?: string
          direction: string
          fee_paid_points: number
          id?: number
          oracle_price_micro_at_trade: number
          peptide_id: number
          peptide_in?: number | null
          peptide_out?: number | null
          points_in?: number | null
          points_out?: number | null
          pool_id: number
          pool_price_after: number
          user_id: string
        }
        Update: {
          created_at?: string
          direction?: string
          fee_paid_points?: number
          id?: number
          oracle_price_micro_at_trade?: number
          peptide_id?: number
          peptide_in?: number | null
          peptide_out?: number | null
          points_in?: number | null
          points_out?: number | null
          pool_id?: number
          pool_price_after?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "amm_trades_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "amm_trades_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "amm_pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "amm_trades_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_events: {
        Row: {
          current_observation_id: number
          current_tier: Database["public"]["Enums"]["availability_tier"] | null
          detected_at: string
          event_type: Database["public"]["Enums"]["event_type"]
          id: number
          notes: string | null
          peptide_id: number
          previous_observation_id: number | null
          previous_tier: Database["public"]["Enums"]["availability_tier"] | null
          supplier_id: number
          supplier_product_id: number
        }
        Insert: {
          current_observation_id: number
          current_tier?: Database["public"]["Enums"]["availability_tier"] | null
          detected_at?: string
          event_type: Database["public"]["Enums"]["event_type"]
          id?: number
          notes?: string | null
          peptide_id: number
          previous_observation_id?: number | null
          previous_tier?:
            | Database["public"]["Enums"]["availability_tier"]
            | null
          supplier_id: number
          supplier_product_id: number
        }
        Update: {
          current_observation_id?: number
          current_tier?: Database["public"]["Enums"]["availability_tier"] | null
          detected_at?: string
          event_type?: Database["public"]["Enums"]["event_type"]
          id?: number
          notes?: string | null
          peptide_id?: number
          previous_observation_id?: number | null
          previous_tier?:
            | Database["public"]["Enums"]["availability_tier"]
            | null
          supplier_id?: number
          supplier_product_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "availability_events_current_observation_id_fkey"
            columns: ["current_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_events_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_events_previous_observation_id_fkey"
            columns: ["previous_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_events_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_events_supplier_product_id_fkey"
            columns: ["supplier_product_id"]
            isOneToOne: false
            referencedRelation: "supplier_products"
            referencedColumns: ["id"]
          },
        ]
      }
      event_activations: {
        Row: {
          activated_at: string
          amm_pool_id: number
          expires_at: string
          fee_tier_during_activation_bps: number
          id: number
          market_id: number
          oracle_accelerated_until: string
          peptide_id: number
        }
        Insert: {
          activated_at?: string
          amm_pool_id: number
          expires_at: string
          fee_tier_during_activation_bps: number
          id?: number
          market_id: number
          oracle_accelerated_until: string
          peptide_id: number
        }
        Update: {
          activated_at?: string
          amm_pool_id?: number
          expires_at?: string
          fee_tier_during_activation_bps?: number
          id?: number
          market_id?: number
          oracle_accelerated_until?: string
          peptide_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_activations_amm_pool_id_fkey"
            columns: ["amm_pool_id"]
            isOneToOne: false
            referencedRelation: "amm_pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_activations_market_id_fkey"
            columns: ["market_id"]
            isOneToOne: false
            referencedRelation: "prediction_markets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_activations_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
        ]
      }
      leaderboard_snapshots: {
        Row: {
          id: number
          period: string
          rankings: Json
          snapshot_at: string
        }
        Insert: {
          id?: number
          period: string
          rankings: Json
          snapshot_at?: string
        }
        Update: {
          id?: number
          period?: string
          rankings?: Json
          snapshot_at?: string
        }
        Relationships: []
      }
      outlier_log: {
        Row: {
          detected_at: string
          deviation_bps: number | null
          id: number
          median_value: number | null
          observed_value: number | null
          peptide_id: number
          reason: string
          supplier_id: number
          supplier_observation_id: number | null
          supplier_twap_id: number | null
        }
        Insert: {
          detected_at?: string
          deviation_bps?: number | null
          id?: number
          median_value?: number | null
          observed_value?: number | null
          peptide_id: number
          reason: string
          supplier_id: number
          supplier_observation_id?: number | null
          supplier_twap_id?: number | null
        }
        Update: {
          detected_at?: string
          deviation_bps?: number | null
          id?: number
          median_value?: number | null
          observed_value?: number | null
          peptide_id?: number
          reason?: string
          supplier_id?: number
          supplier_observation_id?: number | null
          supplier_twap_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "outlier_log_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outlier_log_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outlier_log_supplier_observation_id_fkey"
            columns: ["supplier_observation_id"]
            isOneToOne: false
            referencedRelation: "supplier_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outlier_log_supplier_twap_id_fkey"
            columns: ["supplier_twap_id"]
            isOneToOne: false
            referencedRelation: "supplier_twaps"
            referencedColumns: ["id"]
          },
        ]
      }
      peptide_twaps: {
        Row: {
          computed_at: string
          created_at: string
          dropped_supplier_twap_ids: number[]
          id: number
          input_supplier_twap_ids: number[]
          median_deviation_bps: number | null
          peptide_id: number
          suppliers_dropped: number
          suppliers_used: number
          twap_usd_per_mg: number
          window_end: string
          window_start: string
        }
        Insert: {
          computed_at: string
          created_at?: string
          dropped_supplier_twap_ids?: number[]
          id?: number
          input_supplier_twap_ids: number[]
          median_deviation_bps?: number | null
          peptide_id: number
          suppliers_dropped?: number
          suppliers_used: number
          twap_usd_per_mg: number
          window_end: string
          window_start: string
        }
        Update: {
          computed_at?: string
          created_at?: string
          dropped_supplier_twap_ids?: number[]
          id?: number
          input_supplier_twap_ids?: number[]
          median_deviation_bps?: number | null
          peptide_id?: number
          suppliers_dropped?: number
          suppliers_used?: number
          twap_usd_per_mg?: number
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "peptide_twaps_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
        ]
      }
      peptides: {
        Row: {
          code: string
          created_at: string
          description: string | null
          display_name: string
          full_name: string
          id: number
          status: Database["public"]["Enums"]["peptide_status"]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          display_name: string
          full_name: string
          id?: number
          status?: Database["public"]["Enums"]["peptide_status"]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          display_name?: string
          full_name?: string
          id?: number
          status?: Database["public"]["Enums"]["peptide_status"]
          updated_at?: string
        }
        Relationships: []
      }
      point_balances: {
        Row: {
          balance: number
          last_updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          last_updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          last_updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "point_balances_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      point_grants: {
        Row: {
          amount: number
          created_at: string
          grant_kind: string
          granted_for_date: string | null
          id: number
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          grant_kind: string
          granted_for_date?: string | null
          id?: number
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          grant_kind?: string
          granted_for_date?: string | null
          id?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "point_grants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      point_ledger: {
        Row: {
          amount: number
          created_at: string
          id: number
          idempotency_key: string | null
          reason: string
          reference_id: number | null
          reference_kind: string | null
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: number
          idempotency_key?: string | null
          reason: string
          reference_id?: number | null
          reference_kind?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: number
          idempotency_key?: string | null
          reason?: string
          reference_id?: number | null
          reference_kind?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "point_ledger_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          amount: number
          avg_entry_price_micro: number
          peptide_id: number
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          avg_entry_price_micro: number
          peptide_id: number
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          avg_entry_price_micro?: number
          peptide_id?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_markets: {
        Row: {
          closes_at: string
          created_at: string
          created_by: string | null
          current_yes_probability: number | null
          id: number
          liquidity_invariant: number
          market_type: Database["public"]["Enums"]["prediction_market_type"]
          no_pool: number
          opened_at: string | null
          outcome: string | null
          peptide_id: number | null
          question: string
          resolution_criteria: Json
          resolution_tier: Database["public"]["Enums"]["resolution_tier"]
          resolved_at: string | null
          state: Database["public"]["Enums"]["prediction_market_state"]
          supplier_id: number | null
          updated_at: string
          yes_pool: number
        }
        Insert: {
          closes_at: string
          created_at?: string
          created_by?: string | null
          current_yes_probability?: number | null
          id?: number
          liquidity_invariant: number
          market_type: Database["public"]["Enums"]["prediction_market_type"]
          no_pool: number
          opened_at?: string | null
          outcome?: string | null
          peptide_id?: number | null
          question: string
          resolution_criteria: Json
          resolution_tier: Database["public"]["Enums"]["resolution_tier"]
          resolved_at?: string | null
          state?: Database["public"]["Enums"]["prediction_market_state"]
          supplier_id?: number | null
          updated_at?: string
          yes_pool: number
        }
        Update: {
          closes_at?: string
          created_at?: string
          created_by?: string | null
          current_yes_probability?: number | null
          id?: number
          liquidity_invariant?: number
          market_type?: Database["public"]["Enums"]["prediction_market_type"]
          no_pool?: number
          opened_at?: string | null
          outcome?: string | null
          peptide_id?: number | null
          question?: string
          resolution_criteria?: Json
          resolution_tier?: Database["public"]["Enums"]["resolution_tier"]
          resolved_at?: string | null
          state?: Database["public"]["Enums"]["prediction_market_state"]
          supplier_id?: number | null
          updated_at?: string
          yes_pool?: number
        }
        Relationships: [
          {
            foreignKeyName: "prediction_markets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_markets_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_markets_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_positions: {
        Row: {
          market_id: number
          no_shares: number
          points_invested: number
          realized_pnl: number
          updated_at: string
          user_id: string
          yes_shares: number
        }
        Insert: {
          market_id: number
          no_shares?: number
          points_invested?: number
          realized_pnl?: number
          updated_at?: string
          user_id: string
          yes_shares?: number
        }
        Update: {
          market_id?: number
          no_shares?: number
          points_invested?: number
          realized_pnl?: number
          updated_at?: string
          user_id?: string
          yes_shares?: number
        }
        Relationships: [
          {
            foreignKeyName: "prediction_positions_market_id_fkey"
            columns: ["market_id"]
            isOneToOne: false
            referencedRelation: "prediction_markets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_positions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_trades: {
        Row: {
          action: string
          created_at: string
          id: number
          implied_probability: number
          market_id: number
          points_amount: number
          shares: number
          side: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: number
          implied_probability: number
          market_id: number
          points_amount: number
          shares: number
          side: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: number
          implied_probability?: number
          market_id?: number
          points_amount?: number
          shares?: number
          side?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_trades_market_id_fkey"
            columns: ["market_id"]
            isOneToOne: false
            referencedRelation: "prediction_markets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_trades_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      scraper_runs: {
        Row: {
          error_summary: string | null
          finished_at: string | null
          git_sha: string | null
          host: string | null
          id: number
          products_attempted: number
          products_failed: number
          products_succeeded: number
          started_at: string
          status: string
        }
        Insert: {
          error_summary?: string | null
          finished_at?: string | null
          git_sha?: string | null
          host?: string | null
          id?: number
          products_attempted?: number
          products_failed?: number
          products_succeeded?: number
          started_at?: string
          status?: string
        }
        Update: {
          error_summary?: string | null
          finished_at?: string | null
          git_sha?: string | null
          host?: string | null
          id?: number
          products_attempted?: number
          products_failed?: number
          products_succeeded?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      supplier_observations: {
        Row: {
          availability_tier: Database["public"]["Enums"]["availability_tier"]
          created_at: string
          fx_rate_to_usd: number | null
          http_status: number | null
          id: number
          lead_time_days: number | null
          observed_at: string
          peptide_id: number
          price_usd_per_mg: number | null
          raw_availability: string | null
          raw_currency: string | null
          raw_html_hash: string | null
          raw_price: number | null
          scrape_error: string | null
          scrape_success: boolean
          scraper_run_id: number
          supplier_id: number
          supplier_product_id: number
        }
        Insert: {
          availability_tier?: Database["public"]["Enums"]["availability_tier"]
          created_at?: string
          fx_rate_to_usd?: number | null
          http_status?: number | null
          id?: number
          lead_time_days?: number | null
          observed_at: string
          peptide_id: number
          price_usd_per_mg?: number | null
          raw_availability?: string | null
          raw_currency?: string | null
          raw_html_hash?: string | null
          raw_price?: number | null
          scrape_error?: string | null
          scrape_success: boolean
          scraper_run_id: number
          supplier_id: number
          supplier_product_id: number
        }
        Update: {
          availability_tier?: Database["public"]["Enums"]["availability_tier"]
          created_at?: string
          fx_rate_to_usd?: number | null
          http_status?: number | null
          id?: number
          lead_time_days?: number | null
          observed_at?: string
          peptide_id?: number
          price_usd_per_mg?: number | null
          raw_availability?: string | null
          raw_currency?: string | null
          raw_html_hash?: string | null
          raw_price?: number | null
          scrape_error?: string | null
          scrape_success?: boolean
          scraper_run_id?: number
          supplier_id?: number
          supplier_product_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "supplier_observations_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_observations_scraper_run_id_fkey"
            columns: ["scraper_run_id"]
            isOneToOne: false
            referencedRelation: "scraper_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_observations_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_observations_supplier_product_id_fkey"
            columns: ["supplier_product_id"]
            isOneToOne: false
            referencedRelation: "supplier_products"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_products: {
        Row: {
          active: boolean
          created_at: string
          id: number
          is_reference_sku: boolean
          mass_per_unit_mg: number
          peptide_id: number
          product_name: string
          product_url: string
          purity_grade: string | null
          supplier_id: number
          supplier_sku: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: number
          is_reference_sku?: boolean
          mass_per_unit_mg: number
          peptide_id: number
          product_name: string
          product_url: string
          purity_grade?: string | null
          supplier_id: number
          supplier_sku: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: number
          is_reference_sku?: boolean
          mass_per_unit_mg?: number
          peptide_id?: number
          product_name?: string
          product_url?: string
          purity_grade?: string | null
          supplier_id?: number
          supplier_sku?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_products_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_products_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_twaps: {
        Row: {
          computed_at: string
          created_at: string
          id: number
          peptide_id: number
          sample_count: number
          sample_count_used: number
          supplier_id: number
          twap_usd_per_mg: number
          window_end: string
          window_start: string
        }
        Insert: {
          computed_at: string
          created_at?: string
          id?: number
          peptide_id: number
          sample_count: number
          sample_count_used: number
          supplier_id: number
          twap_usd_per_mg: number
          window_end: string
          window_start: string
        }
        Update: {
          computed_at?: string
          created_at?: string
          id?: number
          peptide_id?: number
          sample_count?: number
          sample_count_used?: number
          supplier_id?: number
          twap_usd_per_mg?: number
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_twaps_peptide_id_fkey"
            columns: ["peptide_id"]
            isOneToOne: false
            referencedRelation: "peptides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_twaps_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          code: string
          created_at: string
          display_name: string
          homepage_url: string
          id: number
          notes: string | null
          scraper_module: string
          status: Database["public"]["Enums"]["supplier_status"]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          display_name: string
          homepage_url: string
          id?: number
          notes?: string | null
          scraper_module: string
          status?: Database["public"]["Enums"]["supplier_status"]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          display_name?: string
          homepage_url?: string
          id?: number
          notes?: string | null
          scraper_module?: string
          status?: Database["public"]["Enums"]["supplier_status"]
          updated_at?: string
        }
        Relationships: []
      }
      treasury: {
        Row: {
          id: number
          last_updated_at: string
          total_points_collected: number
        }
        Insert: {
          id?: number
          last_updated_at?: string
          total_points_collected?: number
        }
        Update: {
          id?: number
          last_updated_at?: string
          total_points_collected?: number
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          is_admin: boolean
          last_login_at: string | null
          referral_code: string | null
          referred_by: string | null
          status: string
          wallet_pubkey: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          is_admin?: boolean
          last_login_at?: string | null
          referral_code?: string | null
          referred_by?: string | null
          status?: string
          wallet_pubkey?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          is_admin?: boolean
          last_login_at?: string | null
          referral_code?: string | null
          referred_by?: string | null
          status?: string
          wallet_pubkey?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_referred_by_fkey"
            columns: ["referred_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      availability_tier:
        | "in_stock"
        | "low_stock"
        | "lead_time"
        | "out_of_stock"
        | "discontinued"
        | "unknown"
      event_type:
        | "availability_change"
        | "price_spike"
        | "price_crash"
        | "listing_added"
        | "listing_removed"
      peptide_status: "active" | "paused" | "delisted"
      prediction_market_state:
        | "pending"
        | "open"
        | "locked"
        | "resolved"
        | "invalid"
      prediction_market_type: "binary" | "scalar"
      resolution_tier: "tier1_auto" | "tier3_manual"
      supplier_status: "active" | "paused" | "removed"
      vault_status: "pending" | "open" | "closed" | "liquidated"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      availability_tier: [
        "in_stock",
        "low_stock",
        "lead_time",
        "out_of_stock",
        "discontinued",
        "unknown",
      ],
      event_type: [
        "availability_change",
        "price_spike",
        "price_crash",
        "listing_added",
        "listing_removed",
      ],
      peptide_status: ["active", "paused", "delisted"],
      prediction_market_state: [
        "pending",
        "open",
        "locked",
        "resolved",
        "invalid",
      ],
      prediction_market_type: ["binary", "scalar"],
      resolution_tier: ["tier1_auto", "tier3_manual"],
      supplier_status: ["active", "paused", "removed"],
      vault_status: ["pending", "open", "closed", "liquidated"],
    },
  },
} as const
