/**
 * BioHash Peptide Index on-chain writer.
 *
 * Mirrors the shape of apps/oracle/src/peg/peg-pusher.ts: Anchor
 * provider + Program built from the vendored IDL, one method to send
 * `update_index` against the singleton PDA, fire-and-forget error
 * handling, never throws back to the caller.
 *
 * Position in the oracle pipeline (schema 1.1):
 *
 *   TWAP finalize → cohort completion handler writes index_history
 *   row → IndexAccountWriter.updateIndex() pushes the same level to
 *   the on-chain PDA so any program/wallet/indexer can read it
 *   directly via getAccountInfo without going through our API.
 *
 * Failure modes:
 *
 *   - Program not configured (ORACLE_INDEX_PROGRAM_ID unset): the
 *     factory returns null and the runner's call site skips the
 *     on-chain write. Same pattern as PegPusher.
 *   - Pre-cohort hour (off-pattern minute, missing components_hash):
 *     guarded at the runner; this module assumes inputs are valid.
 *   - Replay / out-of-order hour: the program rejects with
 *     NonMonotonicHour; we catch + log, never retry. The next
 *     successful cohort hour will overwrite.
 *   - Account not initialized: the program returns
 *     AccountNotInitialized; we catch + log + warn-once. Operator
 *     must run apps/oracle/scripts/initialize-index-account.ts.
 *   - Authority mismatch: program returns ConstraintHasOne; we
 *     catch + log + warn-once. Operator must rotate via redeploy
 *     (no set_authority in v1).
 *   - RPC transient / blockhash expired: caught + logged. Single
 *     attempt per cycle; the next hour's call is a fresh try.
 *
 * The writer never blocks the runner. All calls return void
 * synchronously; the on-chain send happens on a detached promise.
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

import idlJson from '../index/idl.json' with { type: 'json' };

/** PDA seed prefix. Must match INDEX_SEED_PREFIX in programs/biohash_index/src/lib.rs. */
const INDEX_SEED_PREFIX = Buffer.from('peptide_index');
/** Version seed, frozen at v1. */
const INDEX_VERSION_SEED = Buffer.from('v1');

/** Compute unit budget. update_index is well under 50k CU in practice. */
const CU_LIMIT = 100_000;
/** Priority fee. Same conservative cap as the peg-pusher's fallback. */
const PRIORITY_FEE_MICROLAMPORTS = 1_000;

export interface IndexAccountWriterConfig {
  /** Program ID from ORACLE_INDEX_PROGRAM_ID env var. */
  programId: PublicKey;
}

export interface UpdateIndexArgs {
  /** Index level as a JS Number (e.g. 980.46). Converted to u64 fixed-point with 4 decimals. */
  level: number;
  /** Top-of-window unix seconds (matches twap_commits.computed_at, typically HH:59:00 UTC). */
  hourStartUnix: number;
  /** sha256 hex (64 chars) of the canonical components vector. */
  componentsHash: string;
}

interface UpdateOutcome {
  status: 'submitted' | 'skipped' | 'failed';
  signature?: string;
  reason?: string;
}

/**
 * Convert a JS number representing a 4-decimal display value (e.g.
 * 980.4567) into a u64 fixed-point integer (980_4567). Rounds to the
 * nearest unit; values outside the safe-integer range fall back to
 * Math.round semantics via BN construction from a decimal string.
 *
 * Implemented as toFixed(4) → strip the dot → BN. This avoids the
 * JS float-multiply-by-10000 rounding error that hits values like
 * 980.46 (becomes 9804599 instead of 9804600 via naive multiply).
 */
export function levelToFixedPoint(level: number): BN {
  if (!Number.isFinite(level) || level < 0) {
    throw new Error(`levelToFixedPoint: invalid level ${level}`);
  }
  const [intPart, fracPart = ''] = level.toFixed(4).split('.');
  const padded = (fracPart + '0000').slice(0, 4);
  return new BN(intPart + padded);
}

/**
 * Convert a 64-char lowercase hex string into a Buffer of 32 bytes.
 * Throws on shape mismatch — the runner validates this upstream so
 * this is a defensive check, not a recovery path.
 */
export function componentsHashToBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`componentsHashToBytes: not a 64-char lowercase hex string: ${hex}`);
  }
  return Buffer.from(hex, 'hex');
}

export class IndexAccountWriter {
  private readonly program: Program;
  private readonly pda: PublicKey;
  private warnedUninitialized = false;
  private warnedAuthority = false;

  constructor(
    private readonly connection: Connection,
    private readonly keypair: Keypair,
    private readonly cfg: IndexAccountWriterConfig,
  ) {
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    // The vendored IDL's address field is fixed at the program ID
    // emitted at anchor build time. The provider's programId override
    // happens implicitly because we construct the Program from the IDL
    // address; we cast through Idl to satisfy the typed surface.
    this.program = new Program(idlJson as Idl, provider);
    [this.pda] = PublicKey.findProgramAddressSync(
      [INDEX_SEED_PREFIX, INDEX_VERSION_SEED],
      this.cfg.programId,
    );
  }

  /** Singleton PDA address; exposed for tests + diagnostics. */
  public get indexPda(): PublicKey {
    return this.pda;
  }

  /**
   * Build + send `update_index`. Returns synchronously after the send
   * resolves; the caller awaits this only if it cares about the
   * outcome (the runner does not — it logs the resolved status and
   * moves on).
   */
  public async updateIndex(args: UpdateIndexArgs): Promise<UpdateOutcome> {
    let levelBn: BN;
    let hashBytes: Buffer;
    try {
      levelBn = levelToFixedPoint(args.level);
      hashBytes = componentsHashToBytes(args.componentsHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', reason: `input_invalid: ${msg}` };
    }
    const hourBn = new BN(args.hourStartUnix);

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: CU_LIMIT,
    });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS,
    });

    let updateIx;
    try {
      // The Idl generic loses method types; we cast .methods to any
      // for the call (the IDL itself defines the shape at runtime).
      // The Anchor test suite covers the actual program ABI; this
      // module is the orchestration wrapper.
      const methods = this.program.methods as any;
      updateIx = await methods
        .updateIndex(levelBn, hourBn, Array.from(hashBytes))
        .accounts({
          authority: this.keypair.publicKey,
          indexAccount: this.pda,
        })
        .instruction();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', reason: `build_ix_failed: ${msg}` };
    }

    const tx = new Transaction().add(cuLimitIx, cuPriceIx, updateIx);

    const sendAndConfirm = this.program.provider.sendAndConfirm;
    if (!sendAndConfirm) {
      return {
        status: 'failed',
        reason: 'provider_missing_sendAndConfirm',
      };
    }
    try {
      const sig = await sendAndConfirm.call(this.program.provider, tx, [this.keypair]);
      return { status: 'submitted', signature: sig };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lowered = msg.toLowerCase();
      if (
        lowered.includes('accountnotinitialized') ||
        lowered.includes('account does not exist') ||
        lowered.includes('could not find account')
      ) {
        if (!this.warnedUninitialized) {
          this.warnedUninitialized = true;
          console.warn(
            `[index-account-writer] PDA ${this.pda.toBase58()} not initialized. ` +
              `Run apps/oracle/scripts/initialize-index-account.ts. ` +
              `Subsequent attempts dedup'd until restart.`,
          );
        }
        return { status: 'skipped', reason: 'account_not_initialized' };
      }
      if (lowered.includes('constrainthasone') || lowered.includes('has_one')) {
        if (!this.warnedAuthority) {
          this.warnedAuthority = true;
          console.warn(
            `[index-account-writer] authority mismatch on PDA ${this.pda.toBase58()}. ` +
              `The stored authority does not match the oracle keypair. ` +
              `Redeploy required (no set_authority in v1). ` +
              `Subsequent attempts dedup'd until restart.`,
          );
        }
        return { status: 'failed', reason: 'authority_mismatch' };
      }
      if (lowered.includes('nonmonotonichour') || lowered.includes('strictly greater')) {
        return { status: 'failed', reason: 'non_monotonic_hour' };
      }
      return { status: 'failed', reason: msg };
    }
  }
}

/**
 * Fire-and-forget call site for the cohort-completion runner. Mirrors
 * apps/oracle/src/pollers/twap-poller.ts:triggerCohortCompletionBestEffort
 * in shape: returns void synchronously, errors caught and logged via
 * structured console lines.
 */
export function triggerIndexAccountWriteBestEffort(
  writer: IndexAccountWriter | null,
  args: UpdateIndexArgs & { hourStartIso: string; pdaHint?: string },
): void {
  if (!writer) return;
  void (async () => {
    try {
      const result = await writer.updateIndex({
        level: args.level,
        hourStartUnix: args.hourStartUnix,
        componentsHash: args.componentsHash,
      });
      if (result.status === 'submitted') {
        console.log(
          `[index-account-writer] update_index_submitted ` +
            `hour=${args.hourStartIso} ` +
            `pda=${writer.indexPda.toBase58()} ` +
            `sig=${result.signature}`,
        );
      } else {
        console.error(
          `[index-account-writer] update_index_failed ` +
            `hour=${args.hourStartIso} ` +
            `pda=${writer.indexPda.toBase58()} ` +
            `status=${result.status} ` +
            `reason=${JSON.stringify(result.reason ?? '')}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[index-account-writer] update_index_threw ` +
          `hour=${args.hourStartIso} ` +
          `reason=${JSON.stringify(msg)}`,
      );
    }
  })();
}
