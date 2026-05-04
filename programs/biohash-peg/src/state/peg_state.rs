// PegState — per-peptide on-chain state. Spec §02 §4.1.

use anchor_lang::prelude::*;

#[account]
pub struct PegState {
    /// Peptide code (ASCII, zero-padded right). e.g. "BPC157\0\0\0\0\0\0\0\0\0\0".
    pub peptide_code: [u8; 16],

    /// Address of the SPL Mint for this peptide token. Mint authority MUST be this PDA.
    pub peptide_token_mint: Pubkey,

    /// Pubkey allowed to call update_peg_state. Set at init; immutable in V0.1.
    pub update_authority: Pubkey,

    // ── Latest TWAP push (spec §02 §3.3 unit: micro-USDC per mg, i.e. usd_per_mg × 10⁶) ──
    pub current_twap: u64,
    pub current_twap_slot: u64,
    pub current_twap_updated_at: i64,
    pub current_twap_observation_set_root: [u8; 32],

    // ── Staleness + step bounds (spec §02 §6.2 / §6.3) ──
    pub max_twap_age_slots: u64,
    pub max_twap_step_bps: u16,

    // ── Fee placeholders (spec §02 §3.4 — both 0 in V0.1) ──
    pub mint_fee_bps: u16,
    pub burn_fee_bps: u16,

    // ── Telemetry (not used in pricing logic) ──
    pub total_minted: u128,
    pub total_burned: u128,
    pub mint_count: u64,
    pub burn_count: u64,
    pub update_count: u64,

    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl PegState {
    /// Account data size, exclusive of the 8-byte Anchor discriminator.
    pub const SIZE: usize = 16   // peptide_code
        + 32                     // peptide_token_mint
        + 32                     // update_authority
        + 8                      // current_twap
        + 8                      // current_twap_slot
        + 8                      // current_twap_updated_at
        + 32                     // current_twap_observation_set_root
        + 8                      // max_twap_age_slots
        + 2                      // max_twap_step_bps
        + 2                      // mint_fee_bps
        + 2                      // burn_fee_bps
        + 16                     // total_minted
        + 16                     // total_burned
        + 8                      // mint_count
        + 8                      // burn_count
        + 8                      // update_count
        + 1                      // bump
        + 64;                    // _reserved
}
