// mint_peptide_token — deposit USDC, receive peptide tokens at TWAP.
// Spec §02 §5.1.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::PegError;
use crate::events::MintEvent;
use crate::state::{PegState, ReserveState};

const TWAP_SCALE: u128 = 1_000_000;
const BPS_DENOM: u128 = 10_000;

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
    ctx: Context<MintPeptideToken>,
    usdc_amount_in: u64,
    min_tokens_out: u64,
) -> Result<()> {
    require!(usdc_amount_in > 0, PegError::ZeroAmount);

    let peg_state = &ctx.accounts.peg_state;
    require!(peg_state.current_twap > 0, PegError::NoTwapSet);

    let clock = &ctx.accounts.clock;
    let age_slots = clock.slot.saturating_sub(peg_state.current_twap_slot);
    require!(age_slots <= peg_state.max_twap_age_slots, PegError::TwapStale);

    // Fee deduction (V0.1: mint_fee_bps = 0, so usdc_for_mint == usdc_amount_in).
    let usdc_in_u128 = usdc_amount_in as u128;
    let mint_fee = usdc_in_u128
        .checked_mul(peg_state.mint_fee_bps as u128)
        .ok_or(PegError::ArithmeticOverflow)?
        .checked_div(BPS_DENOM)
        .ok_or(PegError::ArithmeticOverflow)?;
    let usdc_for_mint = usdc_in_u128
        .checked_sub(mint_fee)
        .ok_or(PegError::ArithmeticOverflow)?;

    // tokens_out = (usdc_for_mint × 10⁶) / current_twap
    let tokens_out_u128 = usdc_for_mint
        .checked_mul(TWAP_SCALE)
        .ok_or(PegError::ArithmeticOverflow)?
        .checked_div(peg_state.current_twap as u128)
        .ok_or(PegError::ArithmeticOverflow)?;
    let tokens_out: u64 = tokens_out_u128
        .try_into()
        .map_err(|_| error!(PegError::ArithmeticOverflow))?;

    require!(tokens_out >= min_tokens_out, PegError::SlippageExceeded);
    require!(tokens_out > 0, PegError::ZeroAmount);

    // 1. Transfer USDC from user to reserve vault (signed by user).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc_account.to_account_info(),
                to: ctx.accounts.reserve_usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount_in,
    )?;

    // 2. Mint peptide tokens to user (signed by peg_state PDA).
    let peptide_code = peg_state.peptide_code;
    let bump = peg_state.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"peg_state", peptide_code.as_ref(), &[bump]]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.peptide_token_mint.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.peg_state.to_account_info(),
            },
            signer_seeds,
        ),
        tokens_out,
    )?;

    // 3. Telemetry.
    let twap_used = peg_state.current_twap;
    let peg_state = &mut ctx.accounts.peg_state;
    peg_state.total_minted = peg_state
        .total_minted
        .checked_add(tokens_out as u128)
        .ok_or(PegError::ArithmeticOverflow)?;
    peg_state.mint_count = peg_state.mint_count.saturating_add(1);

    let reserve_state = &mut ctx.accounts.reserve_state;
    reserve_state.total_usdc_in = reserve_state
        .total_usdc_in
        .checked_add(usdc_amount_in as u128)
        .ok_or(PegError::ArithmeticOverflow)?;

    emit!(MintEvent {
        user: ctx.accounts.user.key(),
        peptide_code,
        usdc_in: usdc_amount_in,
        tokens_out,
        twap_used,
        slot: clock.slot,
    });

    Ok(())
}
