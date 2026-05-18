//! BioHash index → Base mirror via LayerZero V2.
//!
//! Strawman implementation. The LayerZero V2 Solana OApp surface
//! (endpoint CPI, send options encoding, peer storage) is sketched
//! against the framework's documented patterns but specific imports
//! and account lists are marked TODO and must be verified against
//! the LayerZero V2 Solana SDK at build time. See
//! https://docs.layerzero.network/v2/developers/solana.
//!
//! Three instructions:
//!
//!   - `init_oapp_store` - one-time, by the authority. Allocates the
//!     singleton OApp store PDA, captures the authority pubkey and
//!     the endpoint program ID, sets last_emitted_hour to its zero
//!     state.
//!   - `init_peer` - adds a per-remote-EID peer PDA. The peer address
//!     is a 32-byte LayerZero-canonical form: for EVM destinations,
//!     this is the contract address zero-padded on the left to 32
//!     bytes. The init_peer instruction is callable any number of
//!     times by the authority but each (oapp_store, dst_eid) pair has
//!     exactly one Peer PDA at any time; re-running on the same pair
//!     overwrites.
//!   - `emit_index_update` - every cohort-complete UTC hour, by the
//!     authority. Validates monotonic hour_start, packs the payload,
//!     CPIs into the LayerZero endpoint's send. The max_fee_lamports
//!     argument caps the fee; if quote() returns more, the call
//!     reverts with FeeCapExceeded.
//!
//! The CPI to the endpoint is the part that needs the LayerZero
//! V2 Solana SDK. The strawman below builds the message payload and
//! emits a local event, with the actual send wired as a TODO. Once
//! the SDK is locked, the TODO section becomes the
//! `oapp::endpoint_cpi::send` call (or equivalent) with the full
//! account list.

use anchor_lang::prelude::*;

declare_id!("LZem11111111111111111111111111111111111111");

/// PDA seed for the singleton OApp store.
pub const OAPP_STORE_SEED: &[u8] = b"oapp_store";
/// PDA seed prefix for per-remote peers.
pub const PEER_SEED: &[u8] = b"Peer";

/// Maximum payload size (bytes). The actual on-wire payload is
/// 8 + 8 + 32 + 8 = 56 bytes; the cap is generous to allow schema
/// extension within v1 without bumping the program.
pub const MAX_PAYLOAD_BYTES: usize = 128;

#[program]
pub mod biohash_index_lz_emitter {
    use super::*;

    /// One-time initialisation of the OApp store. The `init`
    /// constraint causes a second call to fail with
    /// `AccountAlreadyInitialized`.
    pub fn init_oapp_store(
        ctx: Context<InitOAppStore>,
        endpoint_program: Pubkey,
    ) -> Result<()> {
        let store = &mut ctx.accounts.oapp_store;
        store.authority = ctx.accounts.authority.key();
        store.endpoint_program = endpoint_program;
        store.last_emitted_hour = i64::MIN;
        store.emit_count = 0;
        store.bump = ctx.bumps.oapp_store;
        store._reserved = [0; 64];
        Ok(())
    }

    /// Add or overwrite a peer for a remote EID. The peer address is
    /// a 32-byte LayerZero-canonical form; for EVM destinations this
    /// is the contract address zero-padded on the left.
    pub fn init_peer(
        ctx: Context<InitPeer>,
        dst_eid: u32,
        peer_address: [u8; 32],
    ) -> Result<()> {
        let peer = &mut ctx.accounts.peer;
        peer.dst_eid = dst_eid;
        peer.peer_address = peer_address;
        peer.bump = ctx.bumps.peer;
        peer._reserved = [0; 32];
        Ok(())
    }

    /// Emit one index update to the destination chain. Validates the
    /// monotonic hour, builds the payload, calls LayerZero send.
    ///
    /// `dst_eid` is the destination endpoint ID; it MUST match the
    /// `peer.dst_eid` of the account passed in.
    /// `max_fee_lamports` is the hard cap on the LayerZero fee for
    /// this send. The program rejects with `FeeCapExceeded` if the
    /// endpoint quote returns more.
    pub fn emit_index_update(
        ctx: Context<EmitIndexUpdate>,
        dst_eid: u32,
        level: u64,
        hour_start_unix: i64,
        components_hash: [u8; 32],
        slot: u64,
        max_fee_lamports: u64,
    ) -> Result<()> {
        let store = &mut ctx.accounts.oapp_store;
        let peer = &ctx.accounts.peer;

        require_eq!(peer.dst_eid, dst_eid, IndexLzError::PeerNotConfigured);
        require!(
            hour_start_unix > store.last_emitted_hour,
            IndexLzError::NonMonotonicHour
        );

        // Pack the payload deterministically in big-endian so EVM
        // consumers can read with abi.decode on a bytes blob in the
        // natural order: level (uint64), hour_start (uint64),
        // components_hash (bytes32), slot (uint64). Total 56 bytes.
        let mut payload: Vec<u8> = Vec::with_capacity(56);
        payload.extend_from_slice(&level.to_be_bytes());
        payload.extend_from_slice(&hour_start_unix.to_be_bytes());
        payload.extend_from_slice(&components_hash);
        payload.extend_from_slice(&slot.to_be_bytes());
        require!(
            payload.len() <= MAX_PAYLOAD_BYTES,
            IndexLzError::MessageTooLarge
        );

        // TODO(layerzero): call oapp::endpoint_cpi::send with:
        //   - endpoint program = store.endpoint_program (verified
        //     against ctx.accounts.endpoint_program by has_one in
        //     the Accounts struct below)
        //   - dst_eid
        //   - peer.peer_address as the receiver
        //   - payload
        //   - options: encode an executor lzReceiveOption with the
        //     gas limit + msg.value caller wants Base to forward.
        //     Reference encoding:
        //     https://docs.layerzero.network/v2/developers/evm/protocol-gas-settings/options
        //   - native_fee: read quoted fee from quote() CPI first;
        //     reject if quote > max_fee_lamports.
        //   - lz_token_fee: 0 for v1 (no LZ token payments)
        //
        // For the strawman we emit a local event with the same
        // payload shape so the wiring on the oracle side is testable
        // end-to-end without the actual CPI. Replace with the real
        // send call before mainnet deploy.
        //
        // let fee = oapp::endpoint_cpi::quote(
        //     ctx.accounts.endpoint_program.to_account_info(),
        //     remaining_accounts_for_quote,
        //     QuoteParams { dst_eid, receiver: peer.peer_address, message: payload.clone(), options, pay_in_lz_token: false },
        // )?;
        // require!(fee.native_fee <= max_fee_lamports, IndexLzError::FeeCapExceeded);
        // oapp::endpoint_cpi::send(
        //     ctx.accounts.endpoint_program.to_account_info(),
        //     remaining_accounts_for_send,
        //     SendParams { dst_eid, receiver: peer.peer_address, message: payload, options, native_fee: fee.native_fee, lz_token_fee: 0 },
        // )?;
        let fee = 0u64; // strawman; real fee comes from quote() above

        store.last_emitted_hour = hour_start_unix;
        store.emit_count = store.emit_count.saturating_add(1);

        emit!(IndexUpdateEmitted {
            dst_eid,
            level,
            hour_start_unix,
            components_hash,
            slot,
            fee_lamports: fee,
        });

        Ok(())
    }
}

/// Singleton OApp state. Layout-locked at v0.1.
#[account]
pub struct OAppStore {
    pub authority: Pubkey,
    pub endpoint_program: Pubkey,
    pub last_emitted_hour: i64,
    pub emit_count: u64,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl OAppStore {
    pub const SPACE: usize = 32 + 32 + 8 + 8 + 1 + 64;
}

/// Per-remote-EID peer.
#[account]
pub struct Peer {
    pub dst_eid: u32,
    pub peer_address: [u8; 32],
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl Peer {
    pub const SPACE: usize = 4 + 32 + 1 + 32;
}

#[derive(Accounts)]
pub struct InitOAppStore<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + OAppStore::SPACE,
        seeds = [OAPP_STORE_SEED],
        bump,
    )]
    pub oapp_store: Account<'info, OAppStore>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(dst_eid: u32)]
pub struct InitPeer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [OAPP_STORE_SEED],
        bump = oapp_store.bump,
        has_one = authority,
    )]
    pub oapp_store: Account<'info, OAppStore>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + Peer::SPACE,
        seeds = [PEER_SEED, oapp_store.key().as_ref(), &dst_eid.to_le_bytes()],
        bump,
    )]
    pub peer: Account<'info, Peer>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(dst_eid: u32)]
pub struct EmitIndexUpdate<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [OAPP_STORE_SEED],
        bump = oapp_store.bump,
        has_one = authority,
        has_one = endpoint_program,
    )]
    pub oapp_store: Account<'info, OAppStore>,

    #[account(
        seeds = [PEER_SEED, oapp_store.key().as_ref(), &dst_eid.to_le_bytes()],
        bump = peer.bump,
    )]
    pub peer: Account<'info, Peer>,

    /// CHECK: validated by has_one = endpoint_program on oapp_store.
    /// The endpoint program is the LayerZero V2 endpoint on Solana.
    pub endpoint_program: UncheckedAccount<'info>,
    // TODO(layerzero): the actual send CPI requires several more
    // accounts forwarded via `remaining_accounts`. The list per
    // current LZ V2 docs typically includes:
    //   - send_library, send_library_config, default_send_library_config
    //   - nonce account (per-OApp-per-EID)
    //   - oapp registry account
    //   - executor config + DVN config accounts
    // These are sourced at runtime from the client; the on-chain
    // program forwards them via ctx.remaining_accounts when invoking
    // oapp::endpoint_cpi::send.
}

#[event]
pub struct IndexUpdateEmitted {
    pub dst_eid: u32,
    pub level: u64,
    pub hour_start_unix: i64,
    pub components_hash: [u8; 32],
    pub slot: u64,
    pub fee_lamports: u64,
}

#[error_code]
pub enum IndexLzError {
    #[msg("hour_start_unix must be strictly greater than the stored value")]
    NonMonotonicHour,
    #[msg("Quoted LayerZero fee exceeds max_fee_lamports")]
    FeeCapExceeded,
    #[msg("No peer configured for the requested destination EID")]
    PeerNotConfigured,
    #[msg("Packed payload exceeds the configured maximum size")]
    MessageTooLarge,
}
