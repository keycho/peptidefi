/**
 * One-shot backfill for migration 0037's three new columns:
 *   commit_cycles.{onchain_memo_bytes, authority_pubkey, confirmed_slot}
 *   twap_commits.{onchain_memo_bytes, authority_pubkey, confirmed_slot}
 *
 * For every finalized row missing any of the three columns, fetch the
 * tx via getTransaction(signature, "finalized") and populate. Idempotent:
 * re-running skips already-backfilled rows. Safe to interrupt — each
 * row is committed independently; --resume picks up where it left off.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-cycle-onchain.ts [--dry-run] [--limit=N]
 *                                              [--cluster=mainnet-beta|devnet]
 *                                              [--table=commit_cycles|twap_commits|both]
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SECRET_KEY (service-role; bypasses RLS)
 *   ORACLE_RPC_URL                    (Helius mainnet for the prod backfill)
 *
 * Why this is a script and not a migration: the work is per-row RPC
 * calls, not a single SQL statement. The Solana RPC's rate limits +
 * the cluster cutover (devnet→mainnet) mean we want explicit operator
 * control over what gets backfilled, with retry / resume / dry-run.
 *
 * Mismatch handling:
 *   - If onchain_memo_bytes != memo_payload, log loudly + ALSO write
 *     onchain_memo_bytes (the chain is canonical truth). The
 *     verifier's INTENT_DRIFT_FROM_ATTESTATION code will surface it
 *     on next read, which is the desired signal.
 *   - If the tx is unknown to the validator (dropped, expired, never
 *     landed): leave the columns null. The verifier's
 *     LEGACY_*_NOT_BACKFILLED codes already handle it.
 *   - If the cycle was committed to a different cluster than
 *     ORACLE_RPC_URL points at (e.g. cluster='devnet' but RPC is
 *     mainnet): skip with a clear log line. Pass --cluster=devnet to
 *     run a separate pass against a devnet RPC if needed.
 */

import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseArgs } from "node:util";

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

interface CliOpts {
  dryRun: boolean;
  limit: number;
  cluster: "mainnet-beta" | "devnet" | "testnet" | null;
  table: "commit_cycles" | "twap_commits" | "both";
}

function parseCli(): CliOpts {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string", default: "1000" },
      cluster: { type: "string" },
      table: { type: "string", default: "both" },
    },
    allowPositionals: false,
  });
  const cluster = values.cluster as string | undefined;
  return {
    dryRun: !!values["dry-run"],
    limit: Number.parseInt(values.limit as string, 10) || 1000,
    cluster:
      cluster === "mainnet-beta" || cluster === "devnet" || cluster === "testnet"
        ? cluster
        : null,
    table:
      values.table === "commit_cycles" ||
      values.table === "twap_commits" ||
      values.table === "both"
        ? values.table
        : "both",
  };
}

function makeSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-peptide-oracle-service": "backfill-script" } },
  });
}

function makeConnection(): Connection {
  const url = process.env.ORACLE_RPC_URL;
  if (!url) throw new Error("ORACLE_RPC_URL is required");
  return new Connection(url, { commitment: "finalized" });
}

interface Attestation {
  slot: number;
  memo: string | null;
  signers: string[];
}

async function fetchAttestation(
  conn: Connection,
  signature: string,
): Promise<Attestation | null> {
  const tx = await conn.getTransaction(signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  const message = tx.transaction.message;
  const accountKeys =
    "staticAccountKeys" in message
      ? (message as { staticAccountKeys: { toBase58(): string }[] }).staticAccountKeys
      : (message as { accountKeys: { toBase58(): string }[] }).accountKeys;
  const numSigs = (message.header?.numRequiredSignatures ?? 1) | 0;
  const signers: string[] = [];
  for (let i = 0; i < numSigs && i < accountKeys.length; i++) {
    signers.push(accountKeys[i]!.toBase58());
  }
  let memo: string | null = null;
  const compiledInstructions =
    "compiledInstructions" in message
      ? (message as { compiledInstructions: { programIdIndex: number; data: Uint8Array }[] })
          .compiledInstructions
      : (message as { instructions: { programIdIndex: number; data: string }[] }).instructions;
  for (const ix of compiledInstructions) {
    const programId = accountKeys[ix.programIdIndex]?.toBase58();
    if (programId !== MEMO_PROGRAM_ID) continue;
    const bytes =
      ix.data instanceof Uint8Array
        ? ix.data
        : (await import("bs58")).default.decode(ix.data);
    memo = Buffer.from(bytes).toString("utf-8");
    break;
  }
  return { slot: tx.slot, memo, signers };
}

interface RowToBackfill {
  pk: string | number;
  signature: string;
  memo_payload: string;
  cluster: string | null;
}

async function fetchPendingRows(
  supabase: SupabaseClient,
  table: "commit_cycles" | "twap_commits",
  cluster: CliOpts["cluster"],
  limit: number,
): Promise<RowToBackfill[]> {
  // Fetch finalized rows where ANY of the three columns is null.
  // Filter on cluster if specified so an operator can do a per-cluster
  // pass (devnet RPC for legacy rows, mainnet RPC for current rows).
  const pkCol = table === "commit_cycles" ? "cycle_id" : "id";
  let q = supabase
    .from(table)
    .select(`${pkCol}, solana_signature, memo_payload, cluster`)
    .eq("status", "finalized")
    .not("solana_signature", "is", null)
    .or(
      "onchain_memo_bytes.is.null,authority_pubkey.is.null,confirmed_slot.is.null",
    )
    .order(pkCol, { ascending: true })
    .limit(limit);
  if (cluster) q = q.eq("cluster", cluster);
  const { data, error } = await q;
  if (error) throw new Error(`fetch ${table}: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    pk: r[pkCol] as string | number,
    signature: r.solana_signature as string,
    memo_payload: (r.memo_payload as string) ?? "",
    cluster: (r.cluster as string | null) ?? null,
  }));
}

async function backfillRow(
  supabase: SupabaseClient,
  conn: Connection,
  table: "commit_cycles" | "twap_commits",
  row: RowToBackfill,
  dryRun: boolean,
): Promise<{ status: "ok" | "tx_not_found" | "memo_drift" | "rpc_error"; detail?: string }> {
  let attestation: Attestation | null;
  try {
    attestation = await fetchAttestation(conn, row.signature);
  } catch (err) {
    return {
      status: "rpc_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!attestation) {
    return { status: "tx_not_found" };
  }

  const memoDrift =
    attestation.memo !== null && row.memo_payload !== attestation.memo;

  if (dryRun) {
    return memoDrift
      ? { status: "memo_drift", detail: "DRY RUN — would write attestation but memos differ" }
      : { status: "ok", detail: "DRY RUN — would write" };
  }

  const pkCol = table === "commit_cycles" ? "cycle_id" : "id";
  const { error } = await supabase
    .from(table)
    .update({
      onchain_memo_bytes: attestation.memo,
      authority_pubkey: attestation.signers[0] ?? null,
      confirmed_slot: attestation.slot,
    })
    .eq(pkCol, row.pk);
  if (error) {
    return { status: "rpc_error", detail: `update failed: ${error.message}` };
  }
  return memoDrift ? { status: "memo_drift" } : { status: "ok" };
}

async function backfillTable(
  supabase: SupabaseClient,
  conn: Connection,
  table: "commit_cycles" | "twap_commits",
  opts: CliOpts,
): Promise<void> {
  console.log(`\n[backfill] table=${table} cluster=${opts.cluster ?? "any"} limit=${opts.limit} dry_run=${opts.dryRun}`);
  const rows = await fetchPendingRows(supabase, table, opts.cluster, opts.limit);
  if (rows.length === 0) {
    console.log(`[backfill] ${table}: nothing to backfill`);
    return;
  }
  console.log(`[backfill] ${table}: ${rows.length} rows to process`);

  const counts = { ok: 0, tx_not_found: 0, memo_drift: 0, rpc_error: 0 };
  let i = 0;
  for (const row of rows) {
    i++;
    const result = await backfillRow(supabase, conn, table, row, opts.dryRun);
    counts[result.status]++;
    const prefix = `[backfill] ${table} ${i}/${rows.length} pk=${row.pk}`;
    if (result.status === "ok") {
      console.log(`${prefix} OK`);
    } else if (result.status === "memo_drift") {
      console.warn(
        `${prefix} MEMO_DRIFT — memo_payload differs from on-chain. ${result.detail ?? "Wrote on-chain bytes; verifier will surface as INTENT_DRIFT_FROM_ATTESTATION on next read."}`,
      );
    } else if (result.status === "tx_not_found") {
      console.warn(
        `${prefix} TX_NOT_FOUND for sig=${row.signature} cluster=${row.cluster}. Skipping (columns stay null).`,
      );
    } else {
      console.error(`${prefix} RPC_ERROR: ${result.detail}`);
    }
    // Light pace so we don't blow Helius free-tier rate limits. ~5/s.
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(
    `[backfill] ${table} DONE: ok=${counts.ok} memo_drift=${counts.memo_drift} tx_not_found=${counts.tx_not_found} rpc_error=${counts.rpc_error}`,
  );
}

async function main(): Promise<void> {
  const opts = parseCli();
  const supabase = makeSupabase();
  const conn = makeConnection();

  if (opts.table === "commit_cycles" || opts.table === "both") {
    await backfillTable(supabase, conn, "commit_cycles", opts);
  }
  if (opts.table === "twap_commits" || opts.table === "both") {
    await backfillTable(supabase, conn, "twap_commits", opts);
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
