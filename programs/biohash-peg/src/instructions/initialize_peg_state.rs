// initialize_peg_state — per-peptide PDA init. Spec §02 §5.4.
//
// V0.1 SCAFFOLD: handler is a no-op placeholder.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::state::PegState;

#[derive(Accounts)]
#[instruction(peptide_code: [u8; 16])]
pub struct InitializePegState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + PegState::SIZE,
        seeds = [b"peg_state", peptide_code.as_ref()],
        bump,
    )]
    pub peg_state: Account<'info, PegState>,

    /// SPL Mint for the peptide token. Mint authority MUST be the
    /// peg_state PDA (verified in handler at implementation time).
    pub peptide_token_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_peg_state_handler(
    _ctx: Context<InitializePegState>,
    _peptide_code: [u8; 16],
    _update_authority: Pubkey,
    _peptide_token_mint: Pubkey,
    _max_twap_age_slots: u64,
    _max_twap_step_bps: u16,
) -> Result<()> {
    // V0.1 scaffold: no-op. Implementation follows spec §02 §4.1 + §5.4.
    Ok(())
}
