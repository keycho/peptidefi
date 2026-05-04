// update_peg_state — oracle pushes a fresh TWAP. Spec §02 §5.3.
//
// peg_state is Boxed to match burn/mint and keep the try_accounts
// frame consistent across the program.

use anchor_lang::prelude::*;

use crate::errors::PegError;
use crate::events::TwapUpdateEvent;
use crate::state::PegState;

#[derive(Accounts)]
pub struct UpdatePegState<'info> {
    /// The BioHash oracle authority. has_one binds this to
    /// peg_state.update_authority — Anchor reverts with
    /// PegError::UnauthorizedUpdater on mismatch.
    pub update_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"peg_state", peg_state.peptide_code.as_ref()],
        bump = peg_state.bump,
        has_one = update_authority @ PegError::UnauthorizedUpdater,
    )]
    pub peg_state: Box<Account<'info, PegState>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn update_handler(
    ctx: Context<UpdatePegState>,
    new_twap: u64,
    observation_set_root: [u8; 32],
) -> Result<()> {
    require!(new_twap > 0, PegError::ZeroAmount);

    let peg_state = &mut **ctx.accounts.peg_state;
    let previous_twap = peg_state.current_twap;

    // Maximum-step check (skipped on first push when current_twap == 0).
    if previous_twap > 0 {
        let delta = if new_twap > previous_twap {
            new_twap - previous_twap
        } else {
            previous_twap - new_twap
        };
        let delta_bps = (delta as u128)
            .checked_mul(10_000)
            .ok_or(PegError::ArithmeticOverflow)?
            .checked_div(previous_twap as u128)
            .ok_or(PegError::ArithmeticOverflow)?;
        require!(
            delta_bps <= peg_state.max_twap_step_bps as u128,
            PegError::TwapStepTooLarge
        );
    }

    let clock = &ctx.accounts.clock;
    peg_state.current_twap = new_twap;
    peg_state.current_twap_slot = clock.slot;
    peg_state.current_twap_updated_at = clock.unix_timestamp;
    peg_state.current_twap_observation_set_root = observation_set_root;
    peg_state.update_count = peg_state.update_count.saturating_add(1);

    emit!(TwapUpdateEvent {
        peptide_code: peg_state.peptide_code,
        previous_twap,
        new_twap,
        observation_set_root,
        slot: clock.slot,
    });

    Ok(())
}
