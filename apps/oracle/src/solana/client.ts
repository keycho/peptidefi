import {
  Connection,
  type SignatureStatus,
  type TransactionConfirmationStatus,
} from "@solana/web3.js";

/**
 * Oracle's Solana RPC client, wrapping @solana/web3.js Connection
 * with the policy decisions from §3.4 / §3.6:
 *
 *   - Recent blockhash cache (§3.4.3): TTL 25s; invalidated on
 *     "blockhash expired" errors. Caps getLatestBlockhash to
 *     ~2 calls/min instead of one per tx.
 *   - Priority fee estimate (§3.4.4): Helius-specific custom RPC
 *     method `getPriorityFeeEstimate`; called per submission with
 *     the unsigned tx as input. Returns micro-lamports/CU.
 *   - sendRawTransaction defaults: skipPreflight=false (let the
 *     RPC simulate first), preflightCommitment='processed' (cheap),
 *     maxRetries=0 (we own the retry loop, not web3.js).
 *   - getSignatureStatus: the §3.4.6 confirmation-poll primitive.
 *     Returns the raw status; caller decides what to do with it.
 *
 * The class doesn't own the keypair, the memo, or any retry
 * scheduling — that's caller responsibility (memo-tx, retry-policy,
 * pollers/*). This module is just the RPC adapter.
 */

export interface SolanaClientOptions {
  /** Helius mainnet/devnet RPC URL with API key. */
  rpcUrl: string;
  /** Optional fallback (§3.6.2). v1 manual failover; not auto-switching. */
  rpcUrlFallback?: string | null;
  /** Cached-blockhash TTL in ms. Default 25_000 per §3.4.3. */
  blockhashCacheTtlMs?: number;
}

export interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
}

export class OracleSolanaClient {
  readonly connection: Connection;
  readonly rpcUrl: string;
  readonly rpcUrlFallback: string | null;
  private readonly ttlMs: number;
  private cached: CachedBlockhash | null = null;

  constructor(opts: SolanaClientOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.rpcUrlFallback = opts.rpcUrlFallback ?? null;
    this.ttlMs = opts.blockhashCacheTtlMs ?? 25_000;
    // commitment='confirmed' is the request default; we explicitly
    // pass 'finalized' on calls that need it. Confirmed is fine for
    // blockhash fetch (the blockhash is just a freshness anchor).
    this.connection = new Connection(opts.rpcUrl, {
      commitment: "confirmed",
    });
  }

  /**
   * Return the cached blockhash if it's still fresh, otherwise fetch.
   *
   * The lastValidBlockHeight is captured alongside the blockhash so
   * the caller can decide if a tx that hasn't confirmed should be
   * treated as expired (per §3.7.4 reconciliation).
   */
  async getLatestBlockhash(forceRefresh = false): Promise<CachedBlockhash> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cached &&
      now - this.cached.fetchedAt < this.ttlMs
    ) {
      return this.cached;
    }
    // 'finalized' commitment for the blockhash fetch makes the
    // returned blockhash valid for at least 150 slots from now, vs
    // 'confirmed' which can rarely return a hash that's already
    // close to expiry.
    const fresh = await this.connection.getLatestBlockhash("finalized");
    this.cached = {
      blockhash: fresh.blockhash,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      fetchedAt: now,
    };
    return this.cached;
  }

  /** Drop the cached blockhash. Called on "blockhash expired" errors. */
  invalidateBlockhash(): void {
    this.cached = null;
  }

  /**
   * Submit an already-signed, serialized transaction. Returns the
   * signature on success.
   *
   * skipPreflight=false (let the RPC simulate before forwarding —
   * surfaces obvious problems like insufficient balance early).
   * maxRetries=0 — we own retries; don't let web3.js queue duplicates.
   */
  async sendRawTransaction(serialized: Buffer | Uint8Array): Promise<string> {
    return this.connection.sendRawTransaction(serialized, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 0,
    });
  }

  /**
   * Look up a signature's confirmation status.
   *
   * Returns null if the validator doesn't recognize the signature
   * (dropped, expired, or never landed). searchTransactionHistory=true
   * extends the lookup window past the recent slot cache, useful
   * when reconciling on restart after a long downtime.
   */
  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    const res = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    return res.value[0] ?? null;
  }

  /** Wallet balance in lamports. Used for the §3.5.2 startup gate. */
  async getBalanceLamports(pubkey: string): Promise<number> {
    return this.connection.getBalance(
      // Lazy import the PublicKey type to keep the module's import
      // surface narrow.
      new (await import("@solana/web3.js")).PublicKey(pubkey),
      "confirmed",
    );
  }

  /**
   * Helius-specific RPC method (§3.4.4). Returns the priority-fee
   * estimate at the requested percentile in micro-lamports/CU.
   *
   * Falls back to a static value if the RPC isn't Helius (e.g. the
   * fallback is a public Solana RPC). The 1000 µlamports default is
   * adequate for non-congested cluster conditions.
   */
  async getPriorityFeeEstimateMicroLamports(
    serializedTxBase64: string,
    percentile: "Min" | "Low" | "Medium" | "High" | "VeryHigh" | "Max" = "High",
  ): Promise<number> {
    if (!this.rpcUrl.includes("helius")) {
      // Public Solana RPC has no priority-fee estimate.
      // Fallback to a static value (see §3.4.4 cap = 50_000).
      return 1000;
    }
    const body = {
      jsonrpc: "2.0",
      id: "oracle-fee-estimate",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: serializedTxBase64,
          options: {
            recommended: true,
            priorityLevel: percentile,
          },
        },
      ],
    };
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `getPriorityFeeEstimate http=${res.status}: ${await res.text()}`,
      );
    }
    const json = (await res.json()) as {
      result?: { priorityFeeEstimate?: number };
      error?: { code: number; message: string };
    };
    if (json.error) {
      throw new Error(
        `getPriorityFeeEstimate rpc=${json.error.code}: ${json.error.message}`,
      );
    }
    const estimate = json.result?.priorityFeeEstimate;
    if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
      throw new Error(
        `getPriorityFeeEstimate: unexpected response shape: ${JSON.stringify(json)}`,
      );
    }
    // Helius returns a float; round up to the nearest integer
    // micro-lamport per CU. ComputeBudgetProgram.setComputeUnitPrice
    // expects a non-negative integer.
    return Math.ceil(estimate);
  }

  /**
   * Best-effort airdrop request — devnet/testnet only. Used by the
   * smoke test, not by production code paths.
   */
  async requestAirdropLamports(
    pubkey: string,
    lamports: number,
  ): Promise<string> {
    const PublicKey = (await import("@solana/web3.js")).PublicKey;
    return this.connection.requestAirdrop(new PublicKey(pubkey), lamports);
  }
}

/**
 * Convenience: is the given confirmation status finalized?
 *
 * web3.js sometimes reports `confirmationStatus: 'finalized'`
 * before the slot is fully committed; double-checking against
 * `confirmations === null` (which means "rooted") is the tightest
 * signal that the slot is permanent. We accept either.
 */
export function isFinalized(status: SignatureStatus | null): boolean {
  if (!status) return false;
  if (status.err !== null && status.err !== undefined) return false;
  const confirmationStatus: TransactionConfirmationStatus | undefined =
    status.confirmationStatus;
  return confirmationStatus === "finalized" || status.confirmations === null;
}
