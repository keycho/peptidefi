// mint_peptide_token — deposit USDC, receive peptide tokens at TWAP.
// Spec §02 §5.1.
//
// V0.1 SCAFFOLD: handler is a no-op placeholder.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{PegState, ReserveState};

#[derive(Accounts)]
pub struct MintPeptideToken<'info> {
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

    #[account(mut, address = peg_state.peptide_token_mint)]
    pub peptide_token_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = reserve_state.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    #[account(mut, address = reserve_state.usdc_vault)]
    pub reserve_usdc_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = peg_state.peptide_token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
}

pub fn mint_handler(
    _ctx: Context<MintPeptideToken>,
    _usdc_amount_in: u64,
    _min_tokens_out: u64,
) -> Result<()> {
    // V0.1 scaffold: no-op. Implementation follows spec §02 §5.1.
    Ok(())
}
