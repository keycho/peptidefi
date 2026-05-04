// initialize_peg_state — per-peptide PDA init. Spec §02 §5.4.
//
// Verifies that the supplied peptide_token_mint's authority equals the
// freshly-derived peg_state PDA before finalising — otherwise the
// program could never mint or burn against this PegState.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::PegError;
use crate::state::PegState;

// Box account fields to keep the generated try_accounts frame under
// the sBPF 4 KB stack limit (matches burn/mint pattern).

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
    pub peg_state: Box<Account<'info, PegState>>,

    /// SPL Mint for the peptide token. Mint authority MUST equal the
    /// peg_state PDA (verified in handler).
    pub peptide_token_mint: Box<Account<'info, Mint>>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_peg_state_handler(
    ctx: Context<InitializePegState>,
    peptide_code: [u8; 16],
    update_authority: Pubkey,
    peptide_token_mint: Pubkey,
    max_twap_age_slots: u64,
    max_twap_step_bps: u16,
) -> Result<()> {
    require!(
        ctx.accounts.peptide_token_mint.key() == peptide_token_mint,
        PegError::MintAuthorityMismatch
    );

    let mint_authority = ctx
        .accounts
        .peptide_token_mint
        .mint_authority
        .ok_or(PegError::MintAuthorityMismatch)?;
    require!(
        mint_authority == ctx.accounts.peg_state.key(),
        PegError::MintAuthorityMismatch
    );

    let peg_state = &mut **ctx.accounts.peg_state;
    peg_state.peptide_code = peptide_code;
    peg_state.peptide_token_mint = peptide_token_mint;
    peg_state.update_authority = update_authority;
    peg_state.current_twap = 0;
    peg_state.current_twap_slot = 0;
    peg_state.current_twap_updated_at = 0;
    peg_state.current_twap_observation_set_root = [0u8; 32];
    peg_state.max_twap_age_slots = max_twap_age_slots;
    peg_state.max_twap_step_bps = max_twap_step_bps;
    peg_state.mint_fee_bps = 0;
    peg_state.burn_fee_bps = 0;
    peg_state.total_minted = 0;
    peg_state.total_burned = 0;
    peg_state.mint_count = 0;
    peg_state.burn_count = 0;
    peg_state.update_count = 0;
    peg_state.bump = ctx.bumps.peg_state;
    peg_state._reserved = [0u8; 64];
    Ok(())
}
