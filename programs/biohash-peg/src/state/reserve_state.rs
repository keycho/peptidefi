// ReserveState — singleton, holds USDC vault reference. Spec §02 §4.2.

use anchor_lang::prelude::*;

#[account]
pub struct ReserveState {
    /// USDC mint (mainnet or devnet, set at init). Immutable in V0.1.
    pub usdc_mint: Pubkey,

    /// SPL Token Account holding USDC. Owned by the reserve_vault PDA
    /// (seeds = [b"reserve_vault"]).
    pub usdc_vault: Pubkey,

    /// Bump for the ["reserve_vault"] PDA (vault authority).
    pub vault_authority_bump: u8,

    /// Bump for the ["reserve_state"] PDA (this account).
    pub reserve_state_bump: u8,

    // ── Telemetry ──
    pub total_usdc_in: u128,
    pub total_usdc_out: u128,

    pub _reserved: [u8; 64],
}

impl ReserveState {
    pub const SIZE: usize = 32   // usdc_mint
        + 32                     // usdc_vault
        + 1                      // vault_authority_bump
        + 1                      // reserve_state_bump
        + 16                     // total_usdc_in
        + 16                     // total_usdc_out
        + 64;                    // _reserved
}
