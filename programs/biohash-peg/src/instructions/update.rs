// update_peg_state — oracle pushes a fresh TWAP. Spec §02 §5.3.
//
// V0.1 SCAFFOLD: handler is a no-op placeholder.

use anchor_lang::prelude::*;

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
        has_one = update_authority @ crate::errors::PegError::UnauthorizedUpdater,
    )]
    pub peg_state: Account<'info, PegState>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn update_handler(
    _ctx: Context<UpdatePegState>,
    _new_twap: u64,
    _observation_set_root: [u8; 32],
) -> Result<()> {
    // V0.1 scaffold: no-op. Implementation follows spec §02 §5.3.
    Ok(())
}
