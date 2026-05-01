import bs58 from "bs58";
import { z } from "zod";

/**
 * Environment-variable loading + validation for the oracle service.
 *
 * Called once at process startup from src/index.ts. Throws synchronously
 * on any validation failure so a misconfigured deploy crashes-and-rolls-
 * back at Railway boot rather than coming up healthy and silently
 * misbehaving.
 *
 * What gets validated here:
 *
 *   - Required env vars are present (refuses to start otherwise — §03.5.2).
 *   - The Solana secret key parses as base58 → 64 bytes (§02 / §03.4.1
 *     keypair contract).
 *   - The derived public key matches PEPTIDE_ORACLE_AUTHORITY_PUBKEY when
 *     set, catching the "wrong keyfile in env var" misconfig before any
 *     tx gets signed.
 *   - All numeric env vars parse to finite positive numbers.
 *   - URLs look like URLs (no validation that they're reachable).
 *
 * What does NOT happen here:
 *
 *   - No network calls (no balance fetch, no Supabase ping). Those happen
 *     after config load in src/index.ts so a config error doesn't depend
 *     on the network being up at boot.
 *   - No Postgres advisory-lock acquisition (§03.8.1). Same rationale.
 *   - The actual @solana/web3.js Keypair object isn't constructed yet
 *     (web3.js is intentionally not a dep of this scaffold ticket; it
 *     lands with the commit-submission ticket). For now we just verify
 *     the bytes parse and have the right length.
 */

// ─── Schema ────────────────────────────────────────────────────────────

// The shape that .env / process.env must satisfy. Numeric env vars come
// in as strings; coerce + validate.
const envSchema = z.object({
  // Required
  ORACLE_SOLANA_PRIVATE_KEY: z.string().min(1, "ORACLE_SOLANA_PRIVATE_KEY is required"),
  ORACLE_RPC_URL: z.string().url("ORACLE_RPC_URL must be a valid URL"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a valid URL"),
  SUPABASE_SECRET_KEY: z.string().min(1, "SUPABASE_SECRET_KEY is required"),
  ORACLE_DATABASE_URL: z
    .string()
    .regex(
      /^postgres(?:ql)?:\/\//,
      "ORACLE_DATABASE_URL must be a postgres:// URL",
    ),

  // Optional with defaults
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),
  ORACLE_RPC_URL_FALLBACK: z.string().url().optional(),

  ORACLE_BALANCE_WARN_SOL: z.coerce.number().positive().default(0.3),
  ORACLE_BALANCE_CRITICAL_SOL: z.coerce.number().positive().default(0.15),
  ORACLE_MIN_STARTUP_BALANCE_SOL: z.coerce.number().positive().default(0.05),
  ORACLE_BALANCE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  ORACLE_CYCLE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  ORACLE_TWAP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  ORACLE_CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  ORACLE_CONFIRMATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),

  ORACLE_HEALTH_STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(1_800_000),
  ORACLE_HEALTH_WARMUP_MS: z.coerce.number().int().positive().default(3_600_000),

  // Phase C retry tuning.
  ORACLE_MAX_TOTAL_RETRIES: z.coerce.number().int().positive().default(20),
  ORACLE_LONG_TAIL_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

  PEPTIDE_ORACLE_AUTHORITY_PUBKEY: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

// ─── Public types ──────────────────────────────────────────────────────

export interface OracleConfig {
  /** Raw 64-byte secret key bytes. Held in-memory only; never logged. */
  solanaSecretKey: Uint8Array;
  /** Base58-encoded public key derived from the secret. Safe to log. */
  solanaPublicKey: string;

  rpcUrl: string;
  rpcUrlFallback: string | null;

  supabaseUrl: string;
  supabaseSecretKey: string;
  databaseUrl: string;

  healthPort: number;

  balance: {
    warnSol: number;
    criticalSol: number;
    minStartupSol: number;
    checkIntervalMs: number;
  };

  poll: {
    cycleIntervalMs: number;
    twapIntervalMs: number;
  };

  confirmation: {
    timeoutMs: number;
    pollIntervalMs: number;
  };

  health: {
    staleThresholdMs: number;
    warmupMs: number;
  };

  retry: {
    maxTotalRetries: number;
    longTailIntervalMs: number;
  };

  nodeEnv: string;
}

// ─── Loader ────────────────────────────────────────────────────────────

export function loadConfig(): OracleConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Oracle config validation failed:\n${issues}\n\n` +
        `See apps/oracle/.env.example for the full list of required + optional vars.`,
    );
  }
  const env = parsed.data;

  // Decode + validate the Solana secret key. Catches typos and accidental
  // pastes of the WRONG kind of base58 string before any signing happens.
  let secretBytes: Uint8Array;
  try {
    secretBytes = bs58.decode(env.ORACLE_SOLANA_PRIVATE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ORACLE_SOLANA_PRIVATE_KEY is not valid base58: ${msg}`);
  }
  if (secretBytes.length !== 64) {
    throw new Error(
      `ORACLE_SOLANA_PRIVATE_KEY decoded to ${secretBytes.length} bytes; expected 64. ` +
        `(solana-keygen produces a 64-byte secret-key array; if you only have the pubkey, ` +
        `you've pasted the wrong value.)`,
    );
  }

  // The Solana ed25519 secret-key layout is [32 bytes seed][32 bytes pubkey].
  // The pubkey is the last 32 bytes — base58-encoded for display.
  const pubkeyBytes = secretBytes.slice(32, 64);
  const solanaPublicKey = bs58.encode(pubkeyBytes);

  // Cross-check against the announced authority pubkey if the operator
  // set PEPTIDE_ORACLE_AUTHORITY_PUBKEY. Mismatch is the "you pasted the
  // wrong keyfile into Railway" misconfig — refuse to start.
  if (
    env.PEPTIDE_ORACLE_AUTHORITY_PUBKEY &&
    env.PEPTIDE_ORACLE_AUTHORITY_PUBKEY !== solanaPublicKey
  ) {
    throw new Error(
      `Authority pubkey mismatch: ORACLE_SOLANA_PRIVATE_KEY derives to ` +
        `${solanaPublicKey} but PEPTIDE_ORACLE_AUTHORITY_PUBKEY is set to ` +
        `${env.PEPTIDE_ORACLE_AUTHORITY_PUBKEY}. ` +
        `Either the key or the pubkey env var is wrong; refusing to start.`,
    );
  }

  // Sanity: warn-threshold > critical-threshold. (We don't refuse to
  // start; an operator might deliberately set them equal during testing.)
  if (env.ORACLE_BALANCE_WARN_SOL <= env.ORACLE_BALANCE_CRITICAL_SOL) {
    console.warn(
      `[config] WARN: ORACLE_BALANCE_WARN_SOL (${env.ORACLE_BALANCE_WARN_SOL}) ` +
        `is not greater than ORACLE_BALANCE_CRITICAL_SOL (${env.ORACLE_BALANCE_CRITICAL_SOL}). ` +
        `The 'low' alert will fire at the same time as 'critical'.`,
    );
  }

  return {
    solanaSecretKey: secretBytes,
    solanaPublicKey,

    rpcUrl: env.ORACLE_RPC_URL,
    rpcUrlFallback: env.ORACLE_RPC_URL_FALLBACK ?? null,

    supabaseUrl: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    databaseUrl: env.ORACLE_DATABASE_URL,

    healthPort: env.HEALTH_PORT,

    balance: {
      warnSol: env.ORACLE_BALANCE_WARN_SOL,
      criticalSol: env.ORACLE_BALANCE_CRITICAL_SOL,
      minStartupSol: env.ORACLE_MIN_STARTUP_BALANCE_SOL,
      checkIntervalMs: env.ORACLE_BALANCE_CHECK_INTERVAL_MS,
    },

    poll: {
      cycleIntervalMs: env.ORACLE_CYCLE_POLL_INTERVAL_MS,
      twapIntervalMs: env.ORACLE_TWAP_POLL_INTERVAL_MS,
    },

    confirmation: {
      timeoutMs: env.ORACLE_CONFIRMATION_TIMEOUT_MS,
      pollIntervalMs: env.ORACLE_CONFIRMATION_POLL_INTERVAL_MS,
    },

    health: {
      staleThresholdMs: env.ORACLE_HEALTH_STALE_THRESHOLD_MS,
      warmupMs: env.ORACLE_HEALTH_WARMUP_MS,
    },

    retry: {
      maxTotalRetries: env.ORACLE_MAX_TOTAL_RETRIES,
      longTailIntervalMs: env.ORACLE_LONG_TAIL_INTERVAL_MS,
    },

    nodeEnv: env.NODE_ENV ?? "development",
  };
}
