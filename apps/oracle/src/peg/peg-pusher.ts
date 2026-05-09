import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
// `BN` is re-exported by @coral-xyz/anchor, but Node's ESM loader
// can't statically detect the named re-export from anchor's CJS
// build. (`SyntaxError: does not provide an export named 'BN'` at
// startup under "type": "module".) Default-importing from bn.js
// directly works in both ESM and CJS — and it's the same class
// anchor would have re-exported anyway.
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import idlJson from "./idl.json" with { type: "json" };
import { logAnomaly } from "@peptide-oracle/shared";

/**
 * PegPusher — invokes update_peg_state on the BioHash peg program
 * after each finalized TWAP commit, keeping the on-chain peg state
 * fresh so mint/burn instructions don't revert with TwapStale.
 *
 * Invariants this module guarantees:
 *
 *  - Best-effort. Push failures are logged and counted but never bubble
 *    up; the TWAP-commit pipeline keeps running.
 *  - Idempotent-ish. Same (peptide_code, twap, root) pushed twice in a
 *    row is harmless on-chain (the second one wastes a fee but the
 *    on-chain state is unchanged); the rate-limit guard prevents this
 *    on the happy path.
 *  - Deterministic skip semantics. A push is "skipped" (vs. "failed")
 *    when we deliberately decide not to call the program — rate limit,
 *    staleness check, max-step pre-flight, missing peg PDA. Skips
 *    don't increment failed_count_24h; they go into a separate
 *    skipped_count_24h bucket so operators can distinguish "we chose
 *    not to" from "the chain rejected us".
 *
 * Trust + safety:
 *
 *  - The update_authority account must equal the oracle's signing
 *    keypair (the peg program's #[account(has_one = update_authority)]
 *    binds this on-chain). We don't verify off-chain; the on-chain
 *    check would catch a misconfiguration with UnauthorizedUpdater
 *    on first attempt.
 *  - Pre-flight max-step check mirrors the on-chain
 *    max_twap_step_bps cap (V0.1 default = 50%). Saves a fee +
 *    a confused log line when we'd otherwise revert.
 *  - Pre-flight staleness check: if the TWAP commit landed > 15000
 *    slots in the past (max_twap_age_slots), pushing it is moot —
 *    the on-chain check would treat it as immediately stale.
 *  - Rate limit: 60s minimum between successful pushes for the same
 *    peptide. Defense-in-depth against duplicate-push bugs from
 *    crash-recovery loops; the natural cadence (hourly) sits well
 *    above the limit.
 */

// ─── Types ─────────────────────────────────────────────────────────

const IDL = idlJson as Idl;

// Empirical: update_peg_state is a tiny account-write + emit!. The
// Anchor + Solana baseline plus our own logic comes to ~12k CU. We
// pad to 30k CU for spike priority + safety; below the 200k default
// budget so no compute-budget bump is strictly required, but explicit
// is safer if the program grows in v0.2.
const COMPUTE_UNIT_LIMIT = 30_000;

// max_twap_age_slots in V0.1 PegState is 15000 (~2 h on mainnet).
// We use the same number locally as a pre-flight gate. If on-chain
// gets reconfigured to a different threshold we'd need to either
// fetch-and-cache it or accept the on-chain reject.
const MAX_TWAP_AGE_SLOTS = 15_000n;

// max_twap_step_bps in V0.1 PegState is 5000 (50%). Same caveat as
// above re: future on-chain reconfigure.
const MAX_TWAP_STEP_BPS = 5000n;

const MIN_PUSH_INTERVAL_MS = 60 * 1000;

const PEG_STATE_SEED = Buffer.from("peg_state");

export type SkipReason =
  | "rate-limited"
  | "stale-commit-slot"
  | "max-step-exceeded"
  | "peg-not-deployed"
  | "zero-twap"
  | "disabled"
  | "not-in-allowlist"
  | "invalid-input";

export interface PushPegStateArgs {
  /**
   * Peptide code as it exists in `peptides.code` (e.g. "BPC157").
   * Must match the on-chain peg_state.peptide_code's first N bytes.
   */
  peptideCode: string;
  /**
   * On-chain TWAP value in micro-USDC per mg × 10⁶ (= u64 unit).
   * E.g. $5.998/mg → 5_998_000n.
   */
  twapValue: bigint;
  /**
   * 32-byte Merkle root from the just-finalized twap_commits row.
   * Stored on the peg_state for off-chain verifiers to correlate the
   * peg with the commit.
   */
  observationSetRoot: Uint8Array;
  /**
   * Slot at which the TWAP commit landed on-chain. Used for the
   * staleness pre-flight: if too far behind current_slot, the
   * on-chain age check would reject regardless.
   */
  commitAtSlot: bigint;
}

export interface PushPegStateResult {
  signature: string | null;
  success: boolean;
  /** Set when we deliberately did not push. Mutually exclusive with success=true. */
  skipped: SkipReason | null;
}

export interface PegPusherConfig {
  programId: PublicKey;
  enabled: boolean;
  /**
   * Lowercase-trimmed peptide codes (caller normalises). Used to
   * gate which peptides this pusher attempts at all.
   */
  peptideCodes: ReadonlySet<string>;
  priorityFeeMicroLamports: number;
  maxRetries: number;
}

export interface PegPusherMetrics {
  push_count_24h: number;
  failed_count_24h: number;
  skipped_count_24h: number;
  last_push_at: string | null;
  last_push_peptide: string | null;
  last_push_signature: string | null;
  /**
   * Heartbeat: timestamp of the most recent pushPegState() invocation,
   * regardless of outcome. Distinguishes "the trigger hasn't fired
   * since startup" (last_check_attempt_at = null) from "the trigger
   * is firing but every attempt is being skipped or failing"
   * (last_check_attempt_at recent, last_push_at stale or null).
   */
  last_check_attempt_at: string | null;
  /** Last peptide code we attempted (any outcome). */
  last_check_peptide: string | null;
  /** Last skip reason + when, for diagnosing silent no-ops. */
  last_skip_reason: SkipReason | null;
  last_skip_at: string | null;
  last_skip_peptide: string | null;
  /** Last failure detail (error message + timestamp + peptide). */
  last_failure_at: string | null;
  last_failure_message: string | null;
  last_failure_peptide: string | null;
}

interface LastPush {
  at: number;
  twapValue: bigint;
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Convert a peptide code like "BPC157" into the [u8; 16] zero-padded
 * byte array the on-chain peg_state.peptide_code field uses for PDA
 * derivation. Throws if the code is longer than 16 bytes.
 */
export function peptideCodeBytes16(code: string): Buffer {
  const ascii = Buffer.from(code, "ascii");
  if (ascii.length === 0 || ascii.length > 16) {
    throw new Error(
      `peg-pusher: peptide_code must be 1-16 ASCII bytes (got ${ascii.length} for "${code}")`,
    );
  }
  const padded = Buffer.alloc(16);
  ascii.copy(padded, 0);
  return padded;
}

export function pegStatePda(
  programId: PublicKey,
  peptideCode: string,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PEG_STATE_SEED, peptideCodeBytes16(peptideCode)],
    programId,
  );
  return pda;
}

/**
 * 50%-step pre-flight. Returns true iff abs(new - prev) / prev > cap.
 * Uses BigInt arithmetic — no float drift.
 */
function exceedsMaxStep(prev: bigint, next: bigint, capBps: bigint): boolean {
  if (prev === 0n) return false; // first push always allowed
  const delta = prev > next ? prev - next : next - prev;
  // delta_bps = delta * 10000 / prev
  const deltaBps = (delta * 10_000n) / prev;
  return deltaBps > capBps;
}

/**
 * Classify an error from the program / RPC into retry buckets.
 * Mirrors the §9 error-handling spec from the peg-pusher ticket.
 */
type ErrorClass =
  /** Network / blockhash / preflight — bump priority + retry. */
  | "RETRYABLE_NETWORK"
  /** Program returned a non-recoverable revert; log and skip. */
  | "NON_RETRYABLE_PROGRAM"
  /** Peg PDA missing — distinct skip path so we can dedupe the warn log. */
  | "PEG_NOT_DEPLOYED"
  /** Anything else; log and treat as fatal for this push. */
  | "UNKNOWN";

function classifyError(err: unknown): ErrorClass {
  const msg = errorString(err).toLowerCase();
  // Anchor / program reverts.
  if (
    msg.includes("twapsteptoolarge") ||
    msg.includes("unauthorizedupdater") ||
    msg.includes("zeroamount") ||
    msg.includes("instruction does not exist")
  ) {
    return "NON_RETRYABLE_PROGRAM";
  }
  // Peg PDA missing for this peptide — Anchor treats as
  // AccountNotInitialized / AccountDidNotDeserialize. The program
  // also surfaces a generic "Account does not exist" from web3.js.
  if (
    msg.includes("accountnotinitialized") ||
    msg.includes("accountdidnotdeserialize") ||
    msg.includes("could not find account") ||
    msg.includes("account does not exist")
  ) {
    return "PEG_NOT_DEPLOYED";
  }
  // Network-level / preflight retryables.
  if (
    msg.includes("blockhash not found") ||
    msg.includes("blockhash expired") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("priority fee") ||
    msg.includes("rate-limited") ||
    msg.includes("429")
  ) {
    return "RETRYABLE_NETWORK";
  }
  return "UNKNOWN";
}

function errorString(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// ─── PegPusher ─────────────────────────────────────────────────────

export class PegPusher {
  private readonly program: Program;
  private readonly lastPush = new Map<string, LastPush>();
  private readonly missingPegLogged = new Set<string>();
  private readonly bucket: PegPusherMetrics = {
    push_count_24h: 0,
    failed_count_24h: 0,
    skipped_count_24h: 0,
    last_push_at: null,
    last_push_peptide: null,
    last_push_signature: null,
    last_check_attempt_at: null,
    last_check_peptide: null,
    last_skip_reason: null,
    last_skip_at: null,
    last_skip_peptide: null,
    last_failure_at: null,
    last_failure_message: null,
    last_failure_peptide: null,
  };
  /** One-shot dedup: log allowlist mismatches once per peptide_code. */
  private readonly allowlistMissLogged = new Set<string>();
  /** Per-event timestamps used to expire 24h counters lazily. */
  private readonly pushTimestamps: number[] = [];
  private readonly failTimestamps: number[] = [];
  private readonly skipTimestamps: number[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly keypair: Keypair,
    private readonly cfg: PegPusherConfig,
  ) {
    // Anchor's Wallet wraps a Keypair into the signTransaction interface
    // the AnchorProvider expects. It only signs — never broadcasts.
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    this.program = new Program(IDL, provider);
  }

  /**
   * Read-only snapshot for /health. Returns a copy so the caller can't
   * mutate internal state.
   */
  metrics(): PegPusherMetrics {
    this.expireBuckets();
    return {
      push_count_24h: this.pushTimestamps.length,
      failed_count_24h: this.failTimestamps.length,
      skipped_count_24h: this.skipTimestamps.length,
      last_push_at: this.bucket.last_push_at,
      last_push_peptide: this.bucket.last_push_peptide,
      last_push_signature: this.bucket.last_push_signature,
      last_check_attempt_at: this.bucket.last_check_attempt_at,
      last_check_peptide: this.bucket.last_check_peptide,
      last_skip_reason: this.bucket.last_skip_reason,
      last_skip_at: this.bucket.last_skip_at,
      last_skip_peptide: this.bucket.last_skip_peptide,
      last_failure_at: this.bucket.last_failure_at,
      last_failure_message: this.bucket.last_failure_message,
      last_failure_peptide: this.bucket.last_failure_peptide,
    };
  }

  /**
   * Push update_peg_state. Best-effort — never throws back to caller.
   * See class-level invariants for skip vs. fail semantics.
   */
  async pushPegState(args: PushPegStateArgs): Promise<PushPegStateResult> {
    // Heartbeat — record the attempt before any pre-flight gate so
    // /health can distinguish "trigger hasn't fired" from "trigger
    // is firing but always skipping". Records even when disabled so
    // a misconfigured deploy still shows the trigger is reaching the
    // pusher.
    const attemptIso = new Date().toISOString();
    this.bucket.last_check_attempt_at = attemptIso;
    this.bucket.last_check_peptide = args.peptideCode;

    if (!this.cfg.enabled) {
      return this.recordSkipped("disabled", args.peptideCode);
    }

    // Allowlist normalisation — both sides lowercased so env-var case
    // doesn't matter. Pre-fix this was strict equality, which silently
    // no-op'd whenever the env var case (or whitespace) didn't exactly
    // match the DB column. Allowlist misses now go through the
    // recorded-skip path so /health surfaces them.
    const peptide = args.peptideCode.trim();
    const peptideKey = peptide.toLowerCase();
    if (!this.cfg.peptideCodes.has(peptideKey)) {
      if (!this.allowlistMissLogged.has(peptideKey)) {
        this.allowlistMissLogged.add(peptideKey);
        console.warn(
          `[peg-pusher] peptide="${args.peptideCode}" not in allowlist ` +
            `[${[...this.cfg.peptideCodes].join(",")}] — skipping (further ` +
            `mismatches for this code dedup'd until restart). Check ` +
            `PEG_PEPTIDES env var matches twap_commits.peptide_code exactly ` +
            `(comparison is case-insensitive but otherwise literal).`,
        );
      }
      return this.recordSkipped("not-in-allowlist", args.peptideCode);
    }

    if (args.twapValue <= 0n) {
      console.warn(`[peg-pusher] peptide=${peptide} skipped: twap=0`);
      return this.recordSkipped("zero-twap", peptide);
    }
    if (args.observationSetRoot.length !== 32) {
      console.error(
        `[peg-pusher] peptide=${peptide} invalid observation_set_root length ${args.observationSetRoot.length} — skipping`,
      );
      return this.recordSkipped("invalid-input", peptide);
    }

    // ── rate limit ─────────────────────────────────────────────
    const last = this.lastPush.get(peptideKey);
    const now = Date.now();
    if (last && now - last.at < MIN_PUSH_INTERVAL_MS) {
      console.warn(
        `[peg-pusher] peptide=${peptide} skipped: rate-limited (last push ${Math.floor((now - last.at) / 1000)}s ago, min ${MIN_PUSH_INTERVAL_MS / 1000}s)`,
      );
      return this.recordSkipped("rate-limited", peptide);
    }

    // ── max-step pre-flight ─────────────────────────────────────
    if (last && exceedsMaxStep(last.twapValue, args.twapValue, MAX_TWAP_STEP_BPS)) {
      console.warn(
        `[peg-pusher] peptide=${peptide} skipped: would exceed max_twap_step_bps ` +
          `(prev=${last.twapValue} new=${args.twapValue}, cap=${MAX_TWAP_STEP_BPS}bps)`,
      );
      return this.recordSkipped("max-step-exceeded", peptide);
    }

    // ── staleness pre-flight ───────────────────────────────────
    let currentSlot: bigint;
    try {
      currentSlot = BigInt(await this.connection.getSlot("confirmed"));
    } catch (err) {
      const msg = errorString(err);
      console.warn(
        `[peg-pusher] peptide=${peptide} getSlot failed; skipping push: ${msg}`,
      );
      return this.recordFailed(peptide, `getSlot failed: ${msg}`);
    }
    if (currentSlot - args.commitAtSlot > MAX_TWAP_AGE_SLOTS) {
      console.warn(
        `[peg-pusher] peptide=${peptide} skipped: commit-slot ${args.commitAtSlot} ` +
          `is ${currentSlot - args.commitAtSlot} slots behind current ${currentSlot} (max ${MAX_TWAP_AGE_SLOTS})`,
      );
      return this.recordSkipped("stale-commit-slot", peptide);
    }

    // ── build + send (with retry on retryable errors) ──────────
    const pegState = pegStatePda(this.cfg.programId, peptide);

    // Build the program ix once; rebuild the wrapping tx per attempt
    // so each attempt gets a fresh blockhash.
    let programIx: TransactionInstruction;
    try {
      // Anchor 0.31 method-builder: name in camelCase, accounts use the
      // names from the IDL. We cast `methods` to a loose any here
      // because the IDL is loaded as a generic Idl (no per-program TS
      // types generated by anchor build); the runtime builder works
      // fine but the static type isn't aware of `updatePegState`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const methods = this.program.methods as any;
      // u64 must be a bn.js BN — Anchor's borsh encoder calls
      // `.toArrayLike()` on integer args, which native bigint /
      // number don't expose. Pass the bigint through `.toString()`
      // so we don't lose precision via Number coercion.
      const twapBn = new BN(args.twapValue.toString());
      programIx = await methods
        .updatePegState(twapBn, Array.from(args.observationSetRoot))
        .accounts({
          updateAuthority: this.keypair.publicKey,
          pegState,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .instruction();
    } catch (err) {
      const msg = errorString(err);
      console.error(`[peg-pusher] peptide=${peptide} ix build failed: ${msg}`);
      return this.recordFailed(peptide, `ix build failed: ${msg}`);
    }

    const totalAttempts = Math.max(1, this.cfg.maxRetries) + 1;
    let priorityFee = this.cfg.priorityFeeMicroLamports;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const attemptResult = await this.tryOnce({
        peptide,
        programIx,
        priorityFee,
        attempt,
      });

      if (attemptResult.kind === "ok") {
        this.lastPush.set(peptideKey, { at: Date.now(), twapValue: args.twapValue });
        this.missingPegLogged.delete(peptideKey); // reset dedup if we had previously logged
        return this.recordSuccess(peptide, attemptResult.signature);
      }

      if (attemptResult.kind === "peg-not-deployed") {
        if (!this.missingPegLogged.has(peptideKey)) {
          console.warn(
            `[peg-pusher] peptide=${peptide} peg PDA missing (${pegState.toBase58()}); skipping. Will dedup further warns until restart or first successful push.`,
          );
          this.missingPegLogged.add(peptideKey);
        }
        return this.recordSkipped("peg-not-deployed", peptide);
      }

      if (attemptResult.kind === "non-retryable") {
        console.error(
          `[peg-pusher] peptide=${peptide} non-retryable program error: ${attemptResult.error}`,
        );
        return this.recordFailed(peptide, `non-retryable: ${attemptResult.error}`);
      }

      // Retryable — bump fee, try again.
      if (attempt < totalAttempts) {
        priorityFee = Math.min(priorityFee * 2, 1_000_000); // cap at 1 lamport/CU
        console.warn(
          `[peg-pusher] peptide=${peptide} attempt ${attempt}/${totalAttempts} retryable: ${attemptResult.error}; retry with priority=${priorityFee}`,
        );
      } else {
        console.error(
          `[peg-pusher] peptide=${peptide} retries exhausted (${totalAttempts} attempts): ${attemptResult.error}`,
        );
        return this.recordFailed(
          peptide,
          `retries exhausted (${totalAttempts}): ${attemptResult.error}`,
        );
      }
    }

    // Unreachable — every loop branch returns. Belt-and-braces in case
    // a future edit drops a branch.
    return this.recordFailed(peptide, "unreachable: retry loop fell through");
  }

  // ─── Per-attempt machinery ───────────────────────────────────────

  private async tryOnce(args: {
    peptide: string;
    programIx: TransactionInstruction;
    priorityFee: number;
    attempt: number;
  }): Promise<
    | { kind: "ok"; signature: string }
    | { kind: "peg-not-deployed" }
    | { kind: "non-retryable"; error: string }
    | { kind: "retryable"; error: string }
  > {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");

      const tx = new Transaction({
        feePayer: this.keypair.publicKey,
        blockhash,
        lastValidBlockHeight,
      });
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: args.priorityFee,
        }),
        args.programIx,
      );
      tx.sign(this.keypair);

      const signature = await this.connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 },
      );

      const conf = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (conf.value.err) {
        const errStr = JSON.stringify(conf.value.err);
        const cls = classifyError(errStr);
        return mapErrorClass(cls, errStr);
      }

      return { kind: "ok", signature };
    } catch (err) {
      const errStr = errorString(err);
      const cls = classifyError(errStr);
      return mapErrorClass(cls, errStr);
    }
  }

  // ─── Counter bookkeeping ─────────────────────────────────────────

  private recordSuccess(peptide: string, signature: string): PushPegStateResult {
    const ts = Date.now();
    this.pushTimestamps.push(ts);
    this.bucket.last_push_at = new Date(ts).toISOString();
    this.bucket.last_push_peptide = peptide;
    this.bucket.last_push_signature = signature;
    console.log(
      `[peg-pusher] peptide=${peptide} pushed sig=${signature} at=${this.bucket.last_push_at}`,
    );
    return { signature, success: true, skipped: null };
  }

  private recordFailed(peptide: string, message: string): PushPegStateResult {
    const ts = Date.now();
    this.failTimestamps.push(ts);
    this.bucket.last_failure_at = new Date(ts).toISOString();
    this.bucket.last_failure_peptide = peptide;
    this.bucket.last_failure_message = message;
    // File a public anomaly entry. Fire-and-forget — the logger
    // never throws and the pusher's own metrics already capture
    // the failure for /health. The anomaly log is the durable
    // operator-visible record. Skips are NOT logged here (they're
    // routine pre-flight gates, visible via /health.last_skip_*).
    void logAnomaly({
      severity: "error",
      eventType: "oracle_commit_failed",
      description: `peg-pusher failed to push ${peptide}: ${message}`,
      peptideId: peptide,
      context: {
        component: "peg-pusher",
        message,
        push_count_24h: this.pushTimestamps.length,
        failed_count_24h: this.failTimestamps.length,
      },
    });
    return { signature: null, success: false, skipped: null };
  }

  private recordSkipped(
    reason: SkipReason,
    peptide: string,
  ): PushPegStateResult {
    const ts = Date.now();
    this.skipTimestamps.push(ts);
    this.bucket.last_skip_at = new Date(ts).toISOString();
    this.bucket.last_skip_reason = reason;
    this.bucket.last_skip_peptide = peptide;
    return { signature: null, success: false, skipped: reason };
  }

  /**
   * Drop bucket entries older than 24 hours. Called from metrics() so
   * the /health response always reflects a 24-hour rolling window
   * without a separate timer.
   */
  private expireBuckets(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    expireInPlace(this.pushTimestamps, cutoff);
    expireInPlace(this.failTimestamps, cutoff);
    expireInPlace(this.skipTimestamps, cutoff);
  }
}

function expireInPlace(arr: number[], cutoff: number): void {
  let i = 0;
  while (i < arr.length && arr[i]! < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

function mapErrorClass(
  cls: ErrorClass,
  errStr: string,
):
  | { kind: "peg-not-deployed" }
  | { kind: "non-retryable"; error: string }
  | { kind: "retryable"; error: string } {
  switch (cls) {
    case "PEG_NOT_DEPLOYED":
      return { kind: "peg-not-deployed" };
    case "NON_RETRYABLE_PROGRAM":
      return { kind: "non-retryable", error: errStr };
    case "RETRYABLE_NETWORK":
      return { kind: "retryable", error: errStr };
    case "UNKNOWN":
    default:
      // Conservative: treat unknown as non-retryable. Better to
      // surface as a failure and have the operator look at it than
      // to retry-loop on something the chain rejected.
      return { kind: "non-retryable", error: errStr };
  }
}
