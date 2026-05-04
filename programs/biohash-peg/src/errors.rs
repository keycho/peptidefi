// BioHash peg error codes. See spec §02 §7 for failure-mode docs.

use anchor_lang::prelude::*;

#[error_code]
pub enum PegError {
    #[msg("No TWAP has been pushed yet; trading is disabled until update_peg_state is called.")]
    NoTwapSet,

    #[msg("TWAP is older than max_twap_age_slots; oracle has not pushed a fresh value within the staleness window.")]
    TwapStale,

    #[msg("TWAP step exceeds max_twap_step_bps; the requested update moves the peg too far in one push.")]
    TwapStepTooLarge,

    #[msg("Caller did not match peg_state.update_authority.")]
    UnauthorizedUpdater,

    #[msg("Amount must be greater than zero.")]
    ZeroAmount,

    #[msg("Slippage exceeded: computed output is below the caller's min_*_out bound.")]
    SlippageExceeded,

    #[msg("Reserve USDC balance insufficient to fulfill burn at current TWAP.")]
    InsufficientReserve,

    #[msg("Arithmetic overflow during fee or amount computation.")]
    ArithmeticOverflow,

    #[msg("peptide_token_mint.mint_authority does not match the derived peg_state PDA.")]
    MintAuthorityMismatch,
}
