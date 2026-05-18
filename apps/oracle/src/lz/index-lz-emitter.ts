/**
 * BioHash index → Base mirror via LayerZero V2.
 *
 * Mirrors apps/oracle/src/solana/index-account-writer.ts in shape:
 * Anchor provider + Program built from the vendored IDL, one method to
 * send `emit_index_update` against the OApp's singleton store, fire-
 * and-forget error handling, never throws back to the caller.
 *
 * Position in the oracle pipeline:
 *
 *   index-history-runner.ts writes index_history, stamps cohort rows,
 *   calls triggerIndexAccountWriteBestEffort (existing Solana PDA write),
 *   then ALSO calls triggerLzEmitBestEffort. The two writes are
 *   independent: a failure in the LayerZero emit never blocks the
 *   Solana PDA write and vice versa.
 *
 * Failure modes (all caught + logged, never thrown):
 *
 *   - Program not configured (ORACLE_LZ_EMITTER_PROGRAM_ID unset):
 *     the factory returns null and the runner skips the call.
 *   - RPC unavailable / blockhash expired: caught + logged. Single
 *     attempt per cycle; the next hour is a fresh try.
 *   - Insufficient SOL for LayerZero fee: caught at sendAndConfirm via
 *     the program's FeeCapExceeded error code; logged + skipped.
 *   - Out-of-order rejection from the emitter (NonMonotonicHour): the
 *     program rejects; we catch + log. The next cohort-complete hour
 *     will overwrite.
 *   - Peer not configured for the destination EID: program returns
 *     PeerNotConfigured; we catch + warn-once until restart.
 *   - LayerZero quote() failure: the program's emit_index_update calls
 *     quote internally as part of the CPI; failures there surface as
 *     a generic send error and are logged with the original reason.
 *
 * The writer never blocks the runner. All calls return void
 * synchronously via triggerLzEmitBestEffort; the on-chain send happens
 * on a detached promise.
 */

import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';

import idlJson from './idl.json' with { type: 'json' };

/** PDA seed prefix for the OApp store account. Must match the seed
 *  constant in the emitter program. */
const OAPP_STORE_SEED = Buffer.from('oapp_store');
/** PDA seed prefix for per-remote-EID peer accounts. */
const PEER_SEED = Buffer.from('Peer');

/** Compute unit budget. emit_index_update CPIs into the endpoint;
 *  LayerZero V2 endpoint send is heavier than a raw PDA write.
 *  400k CU is a safe upper bound; the actual usage is lower. */
const CU_LIMIT = 400_000;
/** Priority fee. Mirrors the existing on-chain writer. */
const PRIORITY_FEE_MICROLAMPORTS = 1_000;

export interface IndexLzEmitterConfig {
  /** Program ID from ORACLE_LZ_EMITTER_PROGRAM_ID. */
  programId: PublicKey;
  /** LayerZero destination endpoint ID (e.g. 30184 for Base mainnet).
   *  Set via ORACLE_LZ_BASE_ENDPOINT_ID. */
  dstEid: number;
  /** LayerZero endpoint program on Solana. Set by the deployer; the
   *  emitter program also stores it, this is a sanity-check copy that
   *  the writer uses to build the CPI account list. */
  endpointProgramId: PublicKey;
  /** Maximum fee in lamports the writer will pay for one send.
   *  Defaults to 10 million lamports (0.01 SOL). The on-chain program
   *  also enforces this cap. */
  maxFeeLamports?: bigint;
}

export interface EmitIndexUpdateArgs {
  /** Index level as a JS Number (e.g. 980.46). Converted to u64 fixed
   *  point with 4 decimals to match the on-chain index program. */
  level: number;
  /** Top-of-window unix seconds. Matches
   *  twap_commits.computed_at, typically HH:59:00 UTC. */
  hourStartUnix: number;
  /** sha256 hex (64 lowercase hex chars) of the canonical components
   *  vector. Same value written to the index program's PDA. */
  componentsHash: string;
  /** Solana slot at which the source index PDA was updated. Carried
   *  in the payload so Base consumers can cross-reference back to a
   *  specific Solana transaction. */
  slot: number;
}

interface EmitOutcome {
  status: 'submitted' | 'skipped' | 'failed';
  signature?: string;
  reason?: string;
}

const DEFAULT_MAX_FEE_LAMPORTS = 10_000_000n;

/** Convert a JS number representing a 4-decimal display value (e.g.
 *  980.4567) into a u64 fixed-point integer (980_4567). Identical to
 *  the helper in solana/index-account-writer.ts; duplicated here to
 *  keep the two modules independent. */
export function levelToFixedPoint(level: number): BN {
  if (!Number.isFinite(level) || level < 0) {
    throw new Error(`levelToFixedPoint: invalid level ${level}`);
  }
  const [intPart, fracPart = ''] = level.toFixed(4).split('.');
  const padded = (fracPart + '0000').slice(0, 4);
  return new BN(intPart + padded);
}

/** Convert a 64-char lowercase hex string into a Buffer of 32 bytes. */
export function componentsHashToBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `componentsHashToBytes: not a 64-char lowercase hex string: ${hex}`,
    );
  }
  return Buffer.from(hex, 'hex');
}

export class IndexLzEmitter {
  private readonly program: Program;
  private readonly oappStorePda: PublicKey;
  private readonly peerPda: PublicKey;
  private readonly maxFeeLamports: bigint;
  private warnedPeerMissing = false;
  private warnedFeeCap = false;

  constructor(
    private readonly connection: Connection,
    private readonly keypair: Keypair,
    private readonly cfg: IndexLzEmitterConfig,
  ) {
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    this.program = new Program(idlJson as Idl, provider);
    [this.oappStorePda] = PublicKey.findProgramAddressSync(
      [OAPP_STORE_SEED],
      this.cfg.programId,
    );
    // Peer PDA seeds: ["Peer", oapp_store, dst_eid_le_bytes].
    // The emitter program packs dst_eid as little-endian u32 bytes;
    // this must match the on-chain seed derivation.
    const dstEidBytes = Buffer.alloc(4);
    dstEidBytes.writeUInt32LE(this.cfg.dstEid, 0);
    [this.peerPda] = PublicKey.findProgramAddressSync(
      [PEER_SEED, this.oappStorePda.toBuffer(), dstEidBytes],
      this.cfg.programId,
    );
    this.maxFeeLamports = cfg.maxFeeLamports ?? DEFAULT_MAX_FEE_LAMPORTS;
  }

  /** OApp store PDA address; exposed for tests + diagnostics. */
  public get oappStore(): PublicKey {
    return this.oappStorePda;
  }

  /** Peer PDA address for the configured destination EID. */
  public get peer(): PublicKey {
    return this.peerPda;
  }

  /** Configured destination endpoint ID. */
  public get dstEid(): number {
    return this.cfg.dstEid;
  }

  /**
   * Build + send `emit_index_update`. Returns the resolved outcome.
   * The caller is the cohort-completion runner via the best-effort
   * wrapper below; nothing else awaits this directly.
   */
  public async emitIndexUpdate(
    args: EmitIndexUpdateArgs,
  ): Promise<EmitOutcome> {
    let levelBn: BN;
    let hashBytes: Buffer;
    try {
      levelBn = levelToFixedPoint(args.level);
      hashBytes = componentsHashToBytes(args.componentsHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', reason: `input_invalid: ${msg}` };
    }
    if (
      !Number.isFinite(args.hourStartUnix) ||
      !Number.isFinite(args.slot) ||
      args.slot < 0
    ) {
      return {
        status: 'failed',
        reason: `input_invalid: hour=${args.hourStartUnix} slot=${args.slot}`,
      };
    }
    const hourBn = new BN(args.hourStartUnix);
    const slotBn = new BN(args.slot);
    const maxFeeBn = new BN(this.maxFeeLamports.toString());

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_LIMIT,
    });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS,
    });

    let emitIx;
    try {
      // The Idl generic loses method types; we cast .methods to any
      // for the call. The IDL itself defines the runtime shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const methods = this.program.methods as any;
      emitIx = await methods
        .emitIndexUpdate(
          this.cfg.dstEid,
          levelBn,
          hourBn,
          Array.from(hashBytes),
          slotBn,
          maxFeeBn,
        )
        .accounts({
          authority: this.keypair.publicKey,
          oappStore: this.oappStorePda,
          peer: this.peerPda,
          endpointProgram: this.cfg.endpointProgramId,
        })
        // The LayerZero V2 endpoint send CPI requires several
        // additional accounts (send_library, send_library_config,
        // default_send_library_config, executor_config, nonce, oapp
        // registry, etc.). The emitter program forwards these via
        // remaining_accounts. The runtime list is built per LayerZero's
        // current Solana SDK; for the strawman we leave this empty and
        // rely on the on-chain program to enforce.
        // .remainingAccounts([])
        .instruction();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', reason: `build_ix_failed: ${msg}` };
    }

    const tx = new Transaction().add(cuLimitIx, cuPriceIx, emitIx);

    const sendAndConfirm = this.program.provider.sendAndConfirm;
    if (!sendAndConfirm) {
      return {
        status: 'failed',
        reason: 'provider_missing_sendAndConfirm',
      };
    }
    try {
      const sig = await sendAndConfirm.call(
        this.program.provider,
        tx,
        [this.keypair],
      );
      return { status: 'submitted', signature: sig };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lowered = msg.toLowerCase();
      if (lowered.includes('nonmonotonichour')) {
        return { status: 'failed', reason: 'non_monotonic_hour' };
      }
      if (lowered.includes('feecapexceeded')) {
        if (!this.warnedFeeCap) {
          this.warnedFeeCap = true;
          console.warn(
            `[index-lz-emitter] quoted LayerZero fee exceeds max ` +
              `${this.maxFeeLamports.toString()} lamports. Increase ` +
              `ORACLE_LZ_MAX_FEE_LAMPORTS to relax the cap. Warn dedup'd ` +
              `until restart.`,
          );
        }
        return { status: 'skipped', reason: 'fee_cap_exceeded' };
      }
      if (lowered.includes('peernotconfigured')) {
        if (!this.warnedPeerMissing) {
          this.warnedPeerMissing = true;
          console.warn(
            `[index-lz-emitter] peer PDA ${this.peerPda.toBase58()} ` +
              `not configured for dst_eid=${this.cfg.dstEid}. Operator ` +
              `must run init_peer on the emitter program. Warn dedup'd ` +
              `until restart.`,
          );
        }
        return { status: 'skipped', reason: 'peer_not_configured' };
      }
      if (
        lowered.includes('accountnotinitialized') ||
        lowered.includes('account does not exist')
      ) {
        if (!this.warnedPeerMissing) {
          this.warnedPeerMissing = true;
          console.warn(
            `[index-lz-emitter] OApp store at ` +
              `${this.oappStorePda.toBase58()} not initialised. Run the ` +
              `init_oapp_store instruction on the emitter program. ` +
              `Warn dedup'd until restart.`,
          );
        }
        return { status: 'skipped', reason: 'oapp_store_not_initialized' };
      }
      if (
        lowered.includes('insufficient lamports') ||
        lowered.includes('insufficient funds')
      ) {
        return { status: 'failed', reason: 'insufficient_sol_for_fee' };
      }
      if (lowered.includes('blockhash not found')) {
        return { status: 'failed', reason: 'blockhash_expired' };
      }
      return { status: 'failed', reason: msg };
    }
  }
}

/**
 * Fire-and-forget call site for the cohort-completion runner. Mirrors
 * the shape of triggerIndexAccountWriteBestEffort in
 * apps/oracle/src/solana/index-account-writer.ts. Returns void
 * synchronously; errors are caught and logged inside the detached
 * IIFE.
 */
export function triggerLzEmitBestEffort(
  emitter: IndexLzEmitter | null,
  args: EmitIndexUpdateArgs & { hourStartIso: string },
): void {
  if (!emitter) return;
  void (async () => {
    try {
      const result = await emitter.emitIndexUpdate({
        level: args.level,
        hourStartUnix: args.hourStartUnix,
        componentsHash: args.componentsHash,
        slot: args.slot,
      });
      if (result.status === 'submitted') {
        console.log(
          `[index-lz-emitter] emit_submitted ` +
            `hour=${args.hourStartIso} ` +
            `dst_eid=${emitter.dstEid} ` +
            `oapp=${emitter.oappStore.toBase58()} ` +
            `sig=${result.signature}`,
        );
      } else {
        console.error(
          `[index-lz-emitter] emit_${result.status} ` +
            `hour=${args.hourStartIso} ` +
            `dst_eid=${emitter.dstEid} ` +
            `reason=${JSON.stringify(result.reason ?? '')}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[index-lz-emitter] emit_threw ` +
          `hour=${args.hourStartIso} ` +
          `reason=${JSON.stringify(msg)}`,
      );
    }
  })();
}
