// initialize_reserve_state — one-time creation of the singleton ReserveState
// PDA + USDC vault. Spec §02 §5.4.
//
// V0.1 SCAFFOLD: handler is a no-op placeholder.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::ReserveState;

#[derive(Accounts)]
pub struct InitializeReserveState<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + ReserveState::SIZE,
        seeds = [b"reserve_state"],
        bump,
    )]
    pub reserve_state: Account<'info, ReserveState>,

    /// PDA that owns the USDC vault token account.
    /// CHECK: derivation only; does not hold data.
    #[account(seeds = [b"reserve_vault"], bump)]
    pub reserve_vault_authority: UncheckedAccount<'info>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        token::mint = usdc_mint,
        token::authority = reserve_vault_authority,
    )]
    pub reserve_usdc_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_reserve_state_handler(
    _ctx: Context<InitializeReserveState>,
    _usdc_mint: Pubkey,
) -> Result<()> {
    // V0.1 scaffold: no-op. Implementation follows spec §02 §4.2 + §5.4.
    Ok(())
}
