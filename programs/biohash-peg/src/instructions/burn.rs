// burn_peptide_token — burn peptide tokens, receive USDC at TWAP.
// Spec §02 §5.2.
//
// V0.1 SCAFFOLD: handler is a no-op placeholder.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{PegState, ReserveState};

#[derive(Accounts)]
pub struct BurnPeptideToken<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"peg_state", peg_state.peptide_code.as_ref()],
        bump = peg_state.bump,
    )]
    pub peg_state: Account<'info, PegState>,

    #[account(
        mut,
        seeds = [b"reserve_state"],
        bump = reserve_state.reserve_state_bump,
    )]
    pub reserve_state: Account<'info, ReserveState>,

    /// Vault authority PDA — signs the USDC out-transfer to the user.
    /// CHECK: derivation only.
    #[account(seeds = [b"reserve_vault"], bump = reserve_state.vault_authority_bump)]
    pub reserve_vault_authority: UncheckedAccount<'info>,

    #[account(mut, address = peg_state.peptide_token_mint)]
    pub peptide_token_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = peg_state.peptide_token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reserve_state.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    #[account(mut, address = reserve_state.usdc_vault)]
    pub reserve_usdc_vault: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
}

pub fn burn_handler(
    _ctx: Context<BurnPeptideToken>,
    _tokens_in: u64,
    _min_usdc_out: u64,
) -> Result<()> {
    // V0.1 scaffold: no-op. Implementation follows spec §02 §5.2.
    Ok(())
}
