// burn_peptide_token — burn peptide tokens, receive USDC at TWAP.
// Spec §02 §5.2.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::PegError;
use crate::events::BurnEvent;
use crate::state::{PegState, ReserveState};

const TWAP_SCALE: u128 = 1_000_000;
const BPS_DENOM: u128 = 10_000;

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
    ctx: Context<BurnPeptideToken>,
    tokens_in: u64,
    min_usdc_out: u64,
) -> Result<()> {
    require!(tokens_in > 0, PegError::ZeroAmount);

    let peg_state = &ctx.accounts.peg_state;
    require!(peg_state.current_twap > 0, PegError::NoTwapSet);

    let clock = &ctx.accounts.clock;
    let age_slots = clock.slot.saturating_sub(peg_state.current_twap_slot);
    require!(age_slots <= peg_state.max_twap_age_slots, PegError::TwapStale);

    // usdc_gross = (tokens_in × current_twap) / 10⁶
    let usdc_gross = (tokens_in as u128)
        .checked_mul(peg_state.current_twap as u128)
        .ok_or(PegError::ArithmeticOverflow)?
        .checked_div(TWAP_SCALE)
        .ok_or(PegError::ArithmeticOverflow)?;

    let usdc_fee = usdc_gross
        .checked_mul(peg_state.burn_fee_bps as u128)
        .ok_or(PegError::ArithmeticOverflow)?
        .checked_div(BPS_DENOM)
        .ok_or(PegError::ArithmeticOverflow)?;
    let usdc_out_u128 = usdc_gross
        .checked_sub(usdc_fee)
        .ok_or(PegError::ArithmeticOverflow)?;
    let usdc_out: u64 = usdc_out_u128
        .try_into()
        .map_err(|_| error!(PegError::ArithmeticOverflow))?;

    require!(usdc_out >= min_usdc_out, PegError::SlippageExceeded);
    require!(usdc_out > 0, PegError::ZeroAmount);

    require!(
        ctx.accounts.reserve_usdc_vault.amount >= usdc_out,
        PegError::InsufficientReserve
    );

    // 1. Burn peptide tokens (signed by user).
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.peptide_token_mint.to_account_info(),
                from: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        tokens_in,
    )?;

    // 2. Transfer USDC from reserve vault to user (signed by reserve_vault PDA).
    let vault_authority_bump = ctx.accounts.reserve_state.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"reserve_vault", &[vault_authority_bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reserve_usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc_account.to_account_info(),
                authority: ctx.accounts.reserve_vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_out,
    )?;

    // 3. Telemetry.
    let twap_used = peg_state.current_twap;
    let peptide_code = peg_state.peptide_code;
    let peg_state = &mut ctx.accounts.peg_state;
    peg_state.total_burned = peg_state
        .total_burned
        .checked_add(tokens_in as u128)
        .ok_or(PegError::ArithmeticOverflow)?;
    peg_state.burn_count = peg_state.burn_count.saturating_add(1);

    let reserve_state = &mut ctx.accounts.reserve_state;
    reserve_state.total_usdc_out = reserve_state
        .total_usdc_out
        .checked_add(usdc_out as u128)
        .ok_or(PegError::ArithmeticOverflow)?;

    emit!(BurnEvent {
        user: ctx.accounts.user.key(),
        peptide_code,
        tokens_in,
        usdc_out,
        twap_used,
        slot: clock.slot,
    });

    Ok(())
}
