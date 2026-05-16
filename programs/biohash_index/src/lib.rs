//! BioHash Peptide Index on-chain account.
//!
//! Singleton PDA holding the latest hourly index level computed by
//! the oracle. Updated once per cohort-complete UTC hour. Read-free
//! for any program, wallet, or indexer via `getAccountInfo`.
//!
//! Two instructions:
//!   - `initialize_index_account` — one-time at deploy, by authority.
//!     Allocates the PDA, seeds immutables (baseline_level,
//!     baseline_timestamp, cohort_size), captures the authority pubkey.
//!   - `update_index` — every cycle, by authority. Replay-protected
//!     via strict-greater-than on `hour_start_unix`. Emits an
//!     `IndexUpdated` event for indexers.
//!
//! No `set_authority` in v1. Key rotation requires program redeploy.
//!
//! PDA seeds: `["peptide_index", "v1"]`.
//!
//! See `docs/PUBLIC_API.md` for the manifest contract that ties
//! `components_hash` back to the IPFS-pinned cycle manifests.

use anchor_lang::prelude::*;

declare_id!("6U9YjCbaym1XaaFmPonE2LHn7mnkij99ZJPpSsHaAu9h");

/// PDA seed prefix. Combined with `INDEX_VERSION_SEED` to derive the
/// singleton index account address.
pub const INDEX_SEED_PREFIX: &[u8] = b"peptide_index";

/// PDA version seed. Frozen at v1; a future schema-breaking change
/// would derive a new PDA at a different version seed rather than
/// reallocating this account.
pub const INDEX_VERSION_SEED: &[u8] = b"v1";

#[program]
pub mod biohash_index_program {
    use super::*;

    /// One-time initialization. Allocates the PDA, sets immutables,
    /// captures the authority. `initialize_index_account` can only
    /// succeed once because the `init` constraint on the account
    /// causes a re-run to fail with `AccountAlreadyInitialized`.
    pub fn initialize_index_account(
        ctx: Context<InitializeIndexAccount>,
        baseline_level: u64,
        baseline_timestamp: i64,
        cohort_size: u8,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let account = &mut ctx.accounts.index_account;

        account.version = 1;
        account.bump = ctx.bumps.index_account;
        account.cohort_size = cohort_size;
        account._pad = [0; 5];
        account.authority = ctx.accounts.authority.key();
        account.baseline_level = baseline_level;
        account.baseline_timestamp = baseline_timestamp;
        // Seed index_level + hour_start_unix to the baseline so the
        // first update_index call passes the strict-greater-than guard
        // and so any reader can ask "what level was last written" and
        // get a meaningful answer even before the oracle has run.
        account.index_level = baseline_level;
        account.hour_start_unix = baseline_timestamp;
        account.last_update_timestamp = clock.unix_timestamp;
        account.last_update_slot = clock.slot;
        account.components_hash = [0; 32];
        account._reserved = [0; 32];

        Ok(())
    }

    /// Replace the current level with a fresh one from the oracle's
    /// cohort-completion runner. `has_one = authority` enforces that
    /// the signer matches the stored authority. The strict-greater-than
    /// check on `hour_start_unix` rejects replays AND out-of-order
    /// writes from a startup-recovery batch that arrived non-monotonic.
    pub fn update_index(
        ctx: Context<UpdateIndex>,
        level: u64,
        hour_start_unix: i64,
        components_hash: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let account = &mut ctx.accounts.index_account;

        require!(
            hour_start_unix > account.hour_start_unix,
            IndexError::NonMonotonicHour
        );

        let previous_level = account.index_level;

        account.index_level = level;
        account.hour_start_unix = hour_start_unix;
        account.components_hash = components_hash;
        account.last_update_timestamp = clock.unix_timestamp;
        account.last_update_slot = clock.slot;

        emit!(IndexUpdated {
            previous_level,
            new_level: level,
            hour_start_unix,
            components_hash,
            slot: clock.slot,
        });

        Ok(())
    }
}

/// Singleton index account. Layout-locked at v1: future schema
/// changes either go into `_reserved` or migrate to a new PDA.
///
/// Total size (incl. 8-byte discriminator): 160 bytes.
#[account]
pub struct PeptideIndexAccount {
    pub version: u8,
    pub bump: u8,
    pub cohort_size: u8,
    pub _pad: [u8; 5],
    pub authority: Pubkey,
    pub baseline_level: u64,
    pub baseline_timestamp: i64,
    pub index_level: u64,
    pub hour_start_unix: i64,
    pub last_update_timestamp: i64,
    pub last_update_slot: u64,
    pub components_hash: [u8; 32],
    pub _reserved: [u8; 32],
}

impl PeptideIndexAccount {
    /// Body size excluding the 8-byte Anchor discriminator.
    /// 1+1+1+5+32+8+8+8+8+8+8+32+32 = 152 bytes.
    pub const SPACE: usize = 1 + 1 + 1 + 5 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 32 + 32;
}

#[derive(Accounts)]
pub struct InitializeIndexAccount<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PeptideIndexAccount::SPACE,
        seeds = [INDEX_SEED_PREFIX, INDEX_VERSION_SEED],
        bump,
    )]
    pub index_account: Account<'info, PeptideIndexAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateIndex<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [INDEX_SEED_PREFIX, INDEX_VERSION_SEED],
        bump = index_account.bump,
        has_one = authority,
    )]
    pub index_account: Account<'info, PeptideIndexAccount>,
}

/// Emitted on every successful `update_index`. Indexers can subscribe
/// to this for an event-driven view of the index time series without
/// repeatedly polling `getAccountInfo`.
#[event]
pub struct IndexUpdated {
    pub previous_level: u64,
    pub new_level: u64,
    pub hour_start_unix: i64,
    pub components_hash: [u8; 32],
    pub slot: u64,
}

#[error_code]
pub enum IndexError {
    #[msg("hour_start_unix must be strictly greater than the stored value")]
    NonMonotonicHour,
}
