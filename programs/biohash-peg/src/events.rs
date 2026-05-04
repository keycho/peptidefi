// Anchor events emitted by the peg program. See spec §02 §7.5.

use anchor_lang::prelude::*;

#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub peptide_code: [u8; 16],
    pub usdc_in: u64,
    pub tokens_out: u64,
    pub twap_used: u64,
    pub slot: u64,
}

#[event]
pub struct BurnEvent {
    pub user: Pubkey,
    pub peptide_code: [u8; 16],
    pub tokens_in: u64,
    pub usdc_out: u64,
    pub twap_used: u64,
    pub slot: u64,
}

#[event]
pub struct TwapUpdateEvent {
    pub peptide_code: [u8; 16],
    pub previous_twap: u64,
    pub new_twap: u64,
    pub observation_set_root: [u8; 32],
    pub slot: u64,
}
