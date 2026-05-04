// BioHash peg program — V0.1.
//
// See docs/specs/02-peg-mechanism.md for the full design spec. This
// crate is the on-chain program that mints and burns BPC-157 SPL
// tokens against a shared USDC reserve at the BioHash oracle's TWAP.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod biohash_peg {
    use super::*;

    /// One-time initialisation of the singleton ReserveState + USDC vault.
    /// See spec §5.4 / §02 §4.2.
    pub fn initialize_reserve_state(
        ctx: Context<InitializeReserveState>,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize_reserve_state::initialize_reserve_state_handler(ctx, usdc_mint)
    }

    /// Per-peptide initialisation. V0.1 deploys exactly one (BPC157).
    /// See spec §5.4 / §02 §4.1.
    pub fn initialize_peg_state(
        ctx: Context<InitializePegState>,
        peptide_code: [u8; 16],
        update_authority: Pubkey,
        peptide_token_mint: Pubkey,
        max_twap_age_slots: u64,
        max_twap_step_bps: u16,
    ) -> Result<()> {
        instructions::initialize_peg_state::initialize_peg_state_handler(
            ctx,
            peptide_code,
            update_authority,
            peptide_token_mint,
            max_twap_age_slots,
            max_twap_step_bps,
        )
    }

    /// Deposit USDC, receive freshly minted peptide tokens at current TWAP.
    /// See spec §5.1.
    pub fn mint_peptide_token(
        ctx: Context<MintPeptideToken>,
        usdc_amount_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        instructions::mint::mint_handler(ctx, usdc_amount_in, min_tokens_out)
    }

    /// Burn peptide tokens, receive USDC from reserve at current TWAP.
    /// See spec §5.2.
    pub fn burn_peptide_token(
        ctx: Context<BurnPeptideToken>,
        tokens_in: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        instructions::burn::burn_handler(ctx, tokens_in, min_usdc_out)
    }

    /// Oracle-only: push a fresh TWAP into PegState. See spec §5.3.
    pub fn update_peg_state(
        ctx: Context<UpdatePegState>,
        new_twap: u64,
        observation_set_root: [u8; 32],
    ) -> Result<()> {
        instructions::update::update_handler(ctx, new_twap, observation_set_root)
    }
}
