/**
 * BioHash peg — one-shot mainnet initialisation.
 *
 *   pnpm init-peg-mainnet [--dry-run] [--bootstrap] [--yes] [--rpc-url=URL]
 *                         [--output=PATH] [--bbpc157-mint=PUBKEY]
 *                         [--twap-value=STR] [--obs-root=HEX]
 *
 * Steps (all idempotent — re-running after a partial failure is safe):
 *
 *   1. initialize_reserve_state(USDC mainnet mint)
 *      Creates reserve_state PDA + reserve_usdc_vault token account.
 *
 *   2. Derive peg_state PDA for "BPC157".
 *
 *   3. Create the $bBPC157 SPL Mint (decimals=6, mint_authority = peg_state PDA,
 *      no freeze authority). The mint's keypair is saved to disk BEFORE the
 *      submission so a crash mid-tx leaves a recoverable artifact.
 *
 *   4. initialize_peg_state(peptide_code, oracle authority, mint,
 *      max_twap_age_slots=15000, max_twap_step_bps=1000)
 *
 *   5. (optional, --bootstrap) update_peg_state — push the latest finalised
 *      mainnet TWAP. Signed by ORACLE_AUTHORITY_KEYPAIR. Without --bootstrap,
 *      the script prints the exact follow-up command.
 *
 * Env vars (no inline keypairs, ever):
 *
 *   PEG_DEPLOYER_KEYPAIR        path to deployer Solana keypair JSON   (required)
 *   ORACLE_AUTHORITY_KEYPAIR    path to oracle authority Solana JSON   (required for --bootstrap)
 *   HELIUS_API_KEY              optional; appended to the default Helius URL
 *   BIOHASH_API_BASE            optional; default https://peptidefi-production-c6d9.up.railway.app
 *
 * Safety rails:
 *
 *   - Genesis-hash guard: connection must point at mainnet-beta or the script exits.
 *   - Program-deployed guard: getAccountInfo(programId) must return a non-null
 *     executable account.
 *   - Deployer balance gate: ≥ 0.5 SOL before any submission.
 *   - Per-step Ctrl+C-in-5s prompt unless --yes.
 *   - Idempotent: every state-changing step is preceded by an existence check,
 *     and a typed-Anchor account fetch where applicable.
 *
 * Output:
 *
 *   scripts/peg-mainnet-init-output.json           (gitignored)
 *   scripts/bbpc157-mint-keypair.json              (gitignored — KEEP SECURE)
 *
 * The mint keypair file is written before the createMint submission. If
 * that submission fails after broadcasting (timeout / network), retry the
 * script with --bbpc157-mint=<saved pubkey> to skip mint creation.
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// NB: `BN` is a re-export from bn.js. It works as a named import here
// only because the root package.json has no `"type": "module"`, so
// scripts run as CJS and Node's CJS loader picks up anchor's
// `exports.BN = ...` without static-export detection getting in the
// way. If the root ever switches to `"type": "module"` (or this file
// moves into an ESM workspace), the import will fail at startup with:
//   SyntaxError: '@coral-xyz/anchor' does not provide an export named 'BN'
// — same trap the oracle hit on Railway. Fix when that happens:
// drop BN from this list and add `import BN from "bn.js"` (default).
// See apps/oracle/src/peg/peg-pusher.ts for the precedent.
import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";

import idlJson from "./idl/biohash_peg.json" with { type: "json" };

// ─── Constants (mainnet, hardcoded — CLI cannot override) ───────────

const PEG_PROGRAM_ID = new PublicKey(
  "2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7",
);
const ORACLE_AUTHORITY = new PublicKey(
  "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7",
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const PEPTIDE_CODE = "BPC157";
const PEPTIDE_TOKEN_DECIMALS = 6;
const MAX_TWAP_AGE_SLOTS = new BN(15_000);
const MAX_TWAP_STEP_BPS = 1_000; // 10% per push (operator decision; tightenable via program upgrade)
const MIN_DEPLOYER_BALANCE_SOL = 0.5;

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const DEFAULT_RPC_URL = "https://mainnet.helius-rpc.com";
const DEFAULT_API_BASE = "https://peptidefi-production-c6d9.up.railway.app";
const DEFAULT_OUTPUT_PATH = "scripts/peg-mainnet-init-output.json";
const DEFAULT_MINT_KEYPAIR_PATH = "scripts/bbpc157-mint-keypair.json";

const PROMPT_COUNTDOWN_SEC = 5;

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// ─── CLI ────────────────────────────────────────────────────────────

interface Cli {
  dryRun: boolean;
  bootstrap: boolean;
  yes: boolean;
  rpcUrl: string;
  outputPath: string;
  mintKeypairPath: string;
  bbpc157MintOverride: string | null;
  twapValueOverride: string | null;
  obsRootOverride: string | null;
  help: boolean;
}

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      bootstrap: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "rpc-url": { type: "string" },
      output: { type: "string" },
      "bbpc157-mint": { type: "string" },
      "twap-value": { type: "string" },
      "obs-root": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const heliusKey = process.env.HELIUS_API_KEY;
  const defaultRpc = heliusKey
    ? `${DEFAULT_RPC_URL}/?api-key=${heliusKey}`
    : DEFAULT_RPC_URL;

  return {
    dryRun: Boolean(values["dry-run"]),
    bootstrap: Boolean(values.bootstrap),
    yes: Boolean(values.yes),
    rpcUrl: values["rpc-url"] ?? defaultRpc,
    outputPath: resolveRepoPath(values.output ?? DEFAULT_OUTPUT_PATH),
    mintKeypairPath: resolveRepoPath(DEFAULT_MINT_KEYPAIR_PATH),
    bbpc157MintOverride: values["bbpc157-mint"] ?? null,
    twapValueOverride: values["twap-value"] ?? null,
    obsRootOverride: values["obs-root"] ?? null,
    help: Boolean(values.help),
  };
}

function resolveRepoPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

function printHelp(): void {
  process.stdout.write(`\
BioHash peg — one-shot mainnet initialisation.

USAGE
  pnpm init-peg-mainnet [flags]

FLAGS
  --dry-run             Plan + log only; submit nothing.
  --bootstrap           Run step 5 (push initial TWAP). Requires
                        ORACLE_AUTHORITY_KEYPAIR env var.
  --yes                 Skip the per-step Ctrl+C-in-5s prompt.
  --rpc-url=URL         Override the RPC URL.
  --output=PATH         Output JSON path (default: ${DEFAULT_OUTPUT_PATH}).
  --bbpc157-mint=PK     Reuse an existing $bBPC157 mint pubkey (resume
                        after a partial run; pairs with the keypair file
                        ${DEFAULT_MINT_KEYPAIR_PATH}).
  --twap-value=STR      Override step 5's TWAP source. Format: numeric
                        string with up to 6 decimals (e.g. "5.998000").
  --obs-root=HEX        Override step 5's observation_set_root. Format:
                        "0x" + 64 hex chars.
  --help                This message.

ENV
  PEG_DEPLOYER_KEYPAIR      path to deployer keypair JSON  (required)
  ORACLE_AUTHORITY_KEYPAIR  path to oracle authority JSON  (required for --bootstrap)
  HELIUS_API_KEY            appended to default Helius URL if --rpc-url not set
  BIOHASH_API_BASE          default ${DEFAULT_API_BASE}
`);
}

// ─── Output / journal ──────────────────────────────────────────────

interface OutputJson {
  program_id: string;
  cluster: "mainnet-beta";
  started_at: string;
  deployer: string | null;
  oracle_authority: string;
  addresses: Partial<{
    reserve_state_pda: string;
    reserve_vault_authority_pda: string;
    reserve_usdc_vault: string;
    peg_state_pda_bpc157: string;
    peptide_token_mint_bpc157: string;
  }>;
  transactions: Array<{
    step: number;
    name: string;
    signature: string;
    timestamp: string;
    solscan: string;
  }>;
}

async function loadOutput(p: string): Promise<OutputJson | null> {
  try {
    const buf = await fs.readFile(p, "utf-8");
    return JSON.parse(buf) as OutputJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeOutput(p: string, output: OutputJson): Promise<void> {
  const tmp = `${p}.tmp`;
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(output, null, 2) + "\n");
  await fs.rename(tmp, p);
}

function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

function solscanAccount(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `https://solscan.io/account/${s}`;
}

// ─── Helpers ───────────────────────────────────────────────────────

function loadKeypairFile(p: string): Keypair {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const raw = require("node:fs").readFileSync(p, "utf-8");
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `keypair file ${p} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(
      `keypair file ${p} must be a JSON array of 64 bytes (got ${
        Array.isArray(arr) ? `length ${arr.length}` : typeof arr
      })`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
}

async function saveKeypairFile(p: string, kp: Keypair): Promise<void> {
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(Array.from(kp.secretKey)));
  await fs.chmod(p, 0o600).catch(() => {
    /* best-effort; some filesystems (Windows) don't honour chmod */
  });
}

/** Pad a peptide code to 16 zero-padded ASCII bytes for the PDA seed. */
function peptideCodeBytes16(code: string): Buffer {
  const ascii = Buffer.from(code, "ascii");
  if (ascii.length === 0 || ascii.length > 16) {
    throw new Error(
      `peptide code must be 1-16 ASCII bytes (got ${ascii.length} for "${code}")`,
    );
  }
  const padded = Buffer.alloc(16);
  ascii.copy(padded, 0);
  return padded;
}

/**
 * Convert a numeric(20,6) string into the on-chain peg unit
 * (micro-USDC per mg × 10⁶, BigInt). Pure string → BigInt; no float drift.
 *
 *   "5.998000" → 5_998_000n
 *   "5.998"    → 5_998_000n
 *   "5"        → 5_000_000n
 */
function parseTwapToBaseUnits(s: string): bigint {
  const m = s.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) {
    throw new Error(
      `twap value must be a non-negative decimal with ≤ 6 fractional digits (got "${s}")`,
    );
  }
  const intPart = m[1] ?? "0";
  const fracPart = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  const stripped = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  return BigInt(stripped || "0");
}

function hexToBytes32(hex: string): Uint8Array {
  const clean =
    hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length !== 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(
      `observation_set_root must be "0x" + 64 hex characters (got "${hex}")`,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function accountExists(
  conn: Connection,
  pk: PublicKey,
): Promise<boolean> {
  const info = await conn.getAccountInfo(pk, "confirmed");
  return info !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirmStep(
  name: string,
  cli: { dryRun: boolean; yes: boolean },
): Promise<void> {
  if (cli.dryRun) {
    console.log(`[dry-run] would submit: ${name}`);
    return;
  }
  if (cli.yes) return;
  process.stdout.write(`\n→ About to submit: ${name}\n`);
  for (let i = PROMPT_COUNTDOWN_SEC; i > 0; i--) {
    process.stdout.write(`\r  Submitting in ${i}s... (Ctrl+C to abort) `);
    await sleep(1000);
  }
  process.stdout.write(`\r  Submitting now...                              \n`);
}

function lamportsToSol(lamports: number): string {
  return (lamports / 1e9).toFixed(6);
}

// ─── Bootstrap TWAP source (--bootstrap) ───────────────────────────

interface BootstrapSource {
  twapValue: bigint;
  observationSetRoot: Uint8Array;
  origin: string;
}

async function loadBootstrapSource(
  cli: Cli,
  apiBase: string,
): Promise<BootstrapSource> {
  if (cli.twapValueOverride && cli.obsRootOverride) {
    return {
      twapValue: parseTwapToBaseUnits(cli.twapValueOverride),
      observationSetRoot: hexToBytes32(cli.obsRootOverride),
      origin: "CLI override",
    };
  }
  if (cli.twapValueOverride || cli.obsRootOverride) {
    throw new Error(
      "--twap-value and --obs-root must both be provided together (or neither, to fetch from the API)",
    );
  }
  // Fetch latest finalized mainnet TWAP from the BioHash API.
  const url = `${apiBase}/v1/peptides/${PEPTIDE_CODE}?cluster=mainnet-beta`;
  console.log(`[bootstrap] fetching latest mainnet TWAP from ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `bootstrap fetch failed: HTTP ${res.status} ${res.statusText} from ${url}`,
    );
  }
  const json = (await res.json()) as {
    twap_history?: Array<{
      twap_value: string;
      observation_set_root: string;
      status: string;
      computed_at: string;
      cluster: string;
    }>;
  };
  const latest = json.twap_history?.[0];
  if (!latest) {
    throw new Error(
      `no TWAP history for ${PEPTIDE_CODE} on mainnet-beta yet — wait for the oracle to commit at least one finalised TWAP, or pass --twap-value + --obs-root`,
    );
  }
  if (latest.status !== "finalized") {
    throw new Error(
      `latest mainnet TWAP for ${PEPTIDE_CODE} is status=${latest.status}, expected "finalized" — wait for finalization or pass overrides`,
    );
  }
  if (latest.cluster !== "mainnet-beta") {
    throw new Error(
      `latest TWAP cluster=${latest.cluster}, expected mainnet-beta — API may be misconfigured`,
    );
  }
  return {
    twapValue: parseTwapToBaseUnits(latest.twap_value),
    observationSetRoot: hexToBytes32(latest.observation_set_root),
    origin: `API: ${url} computed_at=${latest.computed_at} value=${latest.twap_value}`,
  };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli();
  if (cli.help) {
    printHelp();
    return;
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BioHash peg — mainnet initialisation");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  mode:              ${cli.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  bootstrap (step 5): ${cli.bootstrap ? "enabled" : "skipped"}`);
  console.log(`  rpc:               ${redactRpc(cli.rpcUrl)}`);
  console.log(`  output:            ${cli.outputPath}`);
  console.log(`  mint keypair:      ${cli.mintKeypairPath}`);
  console.log("");

  // ── load deployer keypair ─────────────────────────────────────────
  const deployerPath = process.env.PEG_DEPLOYER_KEYPAIR;
  if (!deployerPath) {
    throw new Error("env PEG_DEPLOYER_KEYPAIR is required");
  }
  const deployer = loadKeypairFile(deployerPath);
  console.log(`  deployer:          ${deployer.publicKey.toBase58()}`);
  console.log(`  oracle authority:  ${ORACLE_AUTHORITY.toBase58()}`);
  console.log(`  USDC mint:         ${USDC_MINT.toBase58()}`);
  console.log(`  peg program:       ${PEG_PROGRAM_ID.toBase58()}`);
  console.log("");

  // ── load oracle authority keypair (only if bootstrapping) ─────────
  let oracleAuthorityKp: Keypair | null = null;
  if (cli.bootstrap) {
    const oracleAuthPath = process.env.ORACLE_AUTHORITY_KEYPAIR;
    if (!oracleAuthPath) {
      throw new Error(
        "env ORACLE_AUTHORITY_KEYPAIR is required when --bootstrap is set",
      );
    }
    oracleAuthorityKp = loadKeypairFile(oracleAuthPath);
    if (!oracleAuthorityKp.publicKey.equals(ORACLE_AUTHORITY)) {
      throw new Error(
        `ORACLE_AUTHORITY_KEYPAIR pubkey ${oracleAuthorityKp.publicKey.toBase58()} ` +
          `does not match canonical ${ORACLE_AUTHORITY.toBase58()}; refusing to bootstrap`,
      );
    }
  }

  // ── connect ───────────────────────────────────────────────────────
  const connection = new Connection(cli.rpcUrl, "confirmed");

  // Genesis-hash guard.
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `connected to non-mainnet cluster (genesis=${genesis}); refusing to proceed. ` +
        `Mainnet genesis is ${MAINNET_GENESIS_HASH}.`,
    );
  }
  console.log(`  cluster guard:     ✓ mainnet-beta (genesis=${genesis.slice(0, 8)}…)`);

  // Program-deployed guard.
  const programInfo = await connection.getAccountInfo(PEG_PROGRAM_ID, "confirmed");
  if (!programInfo) {
    throw new Error(
      `peg program ${PEG_PROGRAM_ID.toBase58()} not found at this RPC — ` +
        `is the program actually deployed to mainnet?`,
    );
  }
  if (!programInfo.executable) {
    throw new Error(
      `peg program ${PEG_PROGRAM_ID.toBase58()} is not executable; ` +
        `account exists but is not a program`,
    );
  }
  console.log(`  program guard:     ✓ deployed + executable`);

  // Deployer balance gate.
  const deployerLamports = await connection.getBalance(deployer.publicKey, "confirmed");
  console.log(`  deployer balance:  ${lamportsToSol(deployerLamports)} SOL`);
  if (deployerLamports < MIN_DEPLOYER_BALANCE_SOL * 1e9) {
    throw new Error(
      `deployer balance ${lamportsToSol(deployerLamports)} SOL < ` +
        `${MIN_DEPLOYER_BALANCE_SOL} SOL minimum; top up before running`,
    );
  }
  console.log("");

  // ── construct deployer-side Anchor program ────────────────────────
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idlJson as Idl, provider);
  // The IDL is loaded as a generic Idl (no per-program TS types
  // generated by anchor build); cast methods to any so we can call
  // initialize_reserve_state / initialize_peg_state by name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;

  // ── derive PDAs ───────────────────────────────────────────────────
  const [reserveStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_state")],
    PEG_PROGRAM_ID,
  );
  const [reserveVaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_vault")],
    PEG_PROGRAM_ID,
  );
  const peptideCodeSeed = peptideCodeBytes16(PEPTIDE_CODE);
  const [pegStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("peg_state"), peptideCodeSeed],
    PEG_PROGRAM_ID,
  );

  console.log("  derived addresses:");
  console.log(`    reserve_state PDA          : ${reserveStatePda.toBase58()}`);
  console.log(`    reserve_vault_authority PDA: ${reserveVaultAuthorityPda.toBase58()}`);
  console.log(`    peg_state PDA (BPC157)     : ${pegStatePda.toBase58()}`);
  console.log("");

  // ── load or initialise output journal ─────────────────────────────
  const existingOutput = await loadOutput(cli.outputPath);
  const output: OutputJson = existingOutput ?? {
    program_id: PEG_PROGRAM_ID.toBase58(),
    cluster: "mainnet-beta",
    started_at: new Date().toISOString(),
    deployer: deployer.publicKey.toBase58(),
    oracle_authority: ORACLE_AUTHORITY.toBase58(),
    addresses: {},
    transactions: [],
  };
  output.addresses.reserve_state_pda = reserveStatePda.toBase58();
  output.addresses.reserve_vault_authority_pda = reserveVaultAuthorityPda.toBase58();
  output.addresses.peg_state_pda_bpc157 = pegStatePda.toBase58();
  if (!cli.dryRun) await writeOutput(cli.outputPath, output);

  // ─── Step 1: initialize_reserve_state ─────────────────────────────
  console.log("─── Step 1 — initialize_reserve_state ───────────────────────");
  let reserveUsdcVault: PublicKey;

  if (await accountExists(connection, reserveStatePda)) {
    console.log("  reserve_state already exists; skipping submit.");
    // Read existing reserve_state to recover the vault address.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reserve = (await (program.account as any).reserveState.fetch(
      reserveStatePda,
    )) as { usdcMint: PublicKey; usdcVault: PublicKey };
    if (!reserve.usdcMint.equals(USDC_MINT)) {
      throw new Error(
        `reserve_state.usdc_mint ${reserve.usdcMint.toBase58()} does not match ` +
          `expected ${USDC_MINT.toBase58()}; refusing to proceed`,
      );
    }
    reserveUsdcVault = reserve.usdcVault;
    console.log(`  existing reserve_usdc_vault: ${reserveUsdcVault.toBase58()}`);
  } else {
    const vaultKp = Keypair.generate();
    reserveUsdcVault = vaultKp.publicKey;
    console.log(`  fresh reserve_usdc_vault keypair: ${reserveUsdcVault.toBase58()}`);

    await confirmStep("initialize_reserve_state", cli);

    if (!cli.dryRun) {
      const sig: string = await methods
        .initializeReserveState(USDC_MINT)
        .accounts({
          payer: deployer.publicKey,
          reserveState: reserveStatePda,
          reserveVaultAuthority: reserveVaultAuthorityPda,
          usdcMint: USDC_MINT,
          reserveUsdcVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([vaultKp])
        .rpc();
      console.log(`  signature: ${sig}`);
      console.log(`  solscan:   ${solscanTx(sig)}`);
      output.transactions.push({
        step: 1,
        name: "initialize_reserve_state",
        signature: sig,
        timestamp: new Date().toISOString(),
        solscan: solscanTx(sig),
      });
      await writeOutput(cli.outputPath, output);
    } else {
      console.log("  [dry-run] skipping submit");
    }
  }
  output.addresses.reserve_usdc_vault = reserveUsdcVault.toBase58();
  if (!cli.dryRun) await writeOutput(cli.outputPath, output);
  console.log("");

  // ─── Step 2 — peg_state PDA already derived above ─────────────────
  console.log("─── Step 2 — peg_state PDA derivation (no submit) ────────────");
  console.log(`  peg_state PDA: ${pegStatePda.toBase58()}`);
  console.log("");

  // ─── Step 3 — $bBPC157 mint ───────────────────────────────────────
  console.log("─── Step 3 — create $bBPC157 SPL Mint ───────────────────────");
  let peptideMint: PublicKey;

  // If peg_state already exists, the mint is recorded inside it.
  if (await accountExists(connection, pegStatePda)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peg = (await (program.account as any).pegState.fetch(
      pegStatePda,
    )) as { peptideTokenMint: PublicKey };
    peptideMint = peg.peptideTokenMint;
    console.log(`  peg_state already initialised; using its mint: ${peptideMint.toBase58()}`);
  } else if (cli.bbpc157MintOverride) {
    // Operator provided an existing mint via --bbpc157-mint.
    peptideMint = new PublicKey(cli.bbpc157MintOverride);
    console.log(`  using --bbpc157-mint override: ${peptideMint.toBase58()}`);
    // Verify it exists and has the correct authority.
    const mintInfo = await getMint(connection, peptideMint);
    if (mintInfo.mintAuthority?.equals(pegStatePda) !== true) {
      throw new Error(
        `--bbpc157-mint ${peptideMint.toBase58()} mint_authority is ` +
          `${mintInfo.mintAuthority?.toBase58() ?? "null"}, expected ${pegStatePda.toBase58()}`,
      );
    }
    if (mintInfo.decimals !== PEPTIDE_TOKEN_DECIMALS) {
      throw new Error(
        `--bbpc157-mint decimals=${mintInfo.decimals}, expected ${PEPTIDE_TOKEN_DECIMALS}`,
      );
    }
  } else {
    // Generate a fresh mint keypair, save to disk BEFORE submitting,
    // so a crash mid-submit leaves a recoverable artifact.
    const mintKp = Keypair.generate();
    peptideMint = mintKp.publicKey;
    if (!cli.dryRun) {
      await saveKeypairFile(cli.mintKeypairPath, mintKp);
      console.log(
        `  generated fresh mint keypair, saved to ${cli.mintKeypairPath} (chmod 600)`,
      );
    } else {
      console.log(
        `  [dry-run] would generate fresh mint keypair + save to ${cli.mintKeypairPath}`,
      );
    }
    console.log(`  mint pubkey: ${peptideMint.toBase58()}`);
    console.log(`  mint authority (peg_state PDA): ${pegStatePda.toBase58()}`);
    console.log(`  decimals: ${PEPTIDE_TOKEN_DECIMALS}, freeze authority: none`);

    await confirmStep("createMint($bBPC157)", cli);

    if (!cli.dryRun) {
      const created = await createMint(
        connection,
        deployer,
        pegStatePda,
        null,
        PEPTIDE_TOKEN_DECIMALS,
        mintKp,
      );
      if (!created.equals(peptideMint)) {
        throw new Error(
          `createMint returned ${created.toBase58()}, expected ${peptideMint.toBase58()}`,
        );
      }
      console.log(`  mint created: ${peptideMint.toBase58()}`);
      console.log(`  solscan: ${solscanAccount(peptideMint)}`);
      output.transactions.push({
        step: 3,
        name: "createMint($bBPC157)",
        signature: "(spl-token helper; signature not surfaced)",
        timestamp: new Date().toISOString(),
        solscan: solscanAccount(peptideMint),
      });
    }
  }
  output.addresses.peptide_token_mint_bpc157 = peptideMint.toBase58();
  if (!cli.dryRun) await writeOutput(cli.outputPath, output);
  console.log("");

  // ─── Step 4 — initialize_peg_state ────────────────────────────────
  console.log("─── Step 4 — initialize_peg_state ────────────────────────────");
  if (await accountExists(connection, pegStatePda)) {
    console.log("  peg_state already exists; verifying fields and skipping submit.");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peg = (await (program.account as any).pegState.fetch(
      pegStatePda,
    )) as {
      updateAuthority: PublicKey;
      peptideTokenMint: PublicKey;
      maxTwapAgeSlots: BN;
      maxTwapStepBps: number;
    };
    if (!peg.updateAuthority.equals(ORACLE_AUTHORITY)) {
      throw new Error(
        `peg_state.update_authority is ${peg.updateAuthority.toBase58()}, ` +
          `expected ${ORACLE_AUTHORITY.toBase58()}`,
      );
    }
    if (!peg.peptideTokenMint.equals(peptideMint)) {
      throw new Error(
        `peg_state.peptide_token_mint is ${peg.peptideTokenMint.toBase58()}, ` +
          `expected ${peptideMint.toBase58()}`,
      );
    }
    console.log(`  ✓ update_authority matches`);
    console.log(`  ✓ peptide_token_mint matches`);
    console.log(`  recorded max_twap_age_slots=${peg.maxTwapAgeSlots.toString()} bps=${peg.maxTwapStepBps}`);
  } else {
    console.log(`  peptide_code:        "${PEPTIDE_CODE}" (16-byte zero-padded)`);
    console.log(`  update_authority:    ${ORACLE_AUTHORITY.toBase58()}`);
    console.log(`  peptide_token_mint:  ${peptideMint.toBase58()}`);
    console.log(`  max_twap_age_slots:  ${MAX_TWAP_AGE_SLOTS.toString()}`);
    console.log(`  max_twap_step_bps:   ${MAX_TWAP_STEP_BPS}`);

    await confirmStep("initialize_peg_state", cli);

    if (!cli.dryRun) {
      const sig: string = await methods
        .initializePegState(
          Array.from(peptideCodeSeed),
          ORACLE_AUTHORITY,
          peptideMint,
          MAX_TWAP_AGE_SLOTS,
          MAX_TWAP_STEP_BPS,
        )
        .accounts({
          payer: deployer.publicKey,
          pegState: pegStatePda,
          peptideTokenMint: peptideMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  signature: ${sig}`);
      console.log(`  solscan:   ${solscanTx(sig)}`);
      output.transactions.push({
        step: 4,
        name: "initialize_peg_state",
        signature: sig,
        timestamp: new Date().toISOString(),
        solscan: solscanTx(sig),
      });
      await writeOutput(cli.outputPath, output);
    } else {
      console.log("  [dry-run] skipping submit");
    }
  }
  console.log("");

  // ─── Step 5 — bootstrap (optional) ────────────────────────────────
  if (cli.bootstrap) {
    console.log("─── Step 5 — update_peg_state (bootstrap) ────────────────────");
    if (!oracleAuthorityKp) {
      throw new Error("internal: oracleAuthorityKp not loaded despite --bootstrap");
    }

    // If peg_state already has a non-zero current_twap, the peg has
    // already been bootstrapped — skip without raising.
    if (await accountExists(connection, pegStatePda)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peg = (await (program.account as any).pegState.fetch(
        pegStatePda,
      )) as { currentTwap: BN };
      if (!peg.currentTwap.isZero()) {
        console.log(
          `  peg already bootstrapped (current_twap=${peg.currentTwap.toString()}); skipping.`,
        );
        await afterAll(output, cli);
        return;
      }
    }

    const apiBase = process.env.BIOHASH_API_BASE ?? DEFAULT_API_BASE;
    const source = await loadBootstrapSource(cli, apiBase);
    console.log(`  source: ${source.origin}`);
    console.log(`  twap (u64 unit): ${source.twapValue.toString()}`);
    console.log(
      `  observation_set_root: 0x${Buffer.from(source.observationSetRoot).toString("hex")}`,
    );

    await confirmStep("update_peg_state (bootstrap)", cli);

    if (!cli.dryRun) {
      // Build a separate provider for the oracle authority — it has
      // its own keypair, distinct from the deployer's.
      const oracleProvider = new AnchorProvider(
        connection,
        new Wallet(oracleAuthorityKp),
        { commitment: "confirmed", preflightCommitment: "confirmed" },
      );
      const oracleProgram = new Program(idlJson as Idl, oracleProvider);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oracleMethods = oracleProgram.methods as any;
      const sig: string = await oracleMethods
        .updatePegState(
          new BN(source.twapValue.toString()),
          Array.from(source.observationSetRoot),
        )
        .accounts({
          updateAuthority: oracleAuthorityKp.publicKey,
          pegState: pegStatePda,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .rpc();
      console.log(`  signature: ${sig}`);
      console.log(`  solscan:   ${solscanTx(sig)}`);
      output.transactions.push({
        step: 5,
        name: "update_peg_state (bootstrap)",
        signature: sig,
        timestamp: new Date().toISOString(),
        solscan: solscanTx(sig),
      });
      await writeOutput(cli.outputPath, output);
    } else {
      console.log("  [dry-run] skipping submit");
    }
    console.log("");
  } else {
    console.log("─── Step 5 — skipped (no --bootstrap) ────────────────────────");
    console.log("  When ready, push the initial TWAP via:");
    console.log(
      "    ORACLE_AUTHORITY_KEYPAIR=/path/to/oracle.json \\",
    );
    console.log(
      `      pnpm init-peg-mainnet --bootstrap --yes`,
    );
    console.log(
      "  Or with a specific value:",
    );
    console.log(
      `      pnpm init-peg-mainnet --bootstrap --yes \\`,
    );
    console.log(
      `        --twap-value=5.998000 --obs-root=0x100eeb…`,
    );
    console.log("");
  }

  await afterAll(output, cli);
}

async function afterAll(output: OutputJson, cli: Cli): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${cli.dryRun ? "DRY-RUN COMPLETE" : "DONE"}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  reserve_state PDA           : ${output.addresses.reserve_state_pda}`);
  console.log(`  reserve_vault_authority PDA : ${output.addresses.reserve_vault_authority_pda}`);
  console.log(`  reserve_usdc_vault          : ${output.addresses.reserve_usdc_vault}`);
  console.log(`  peg_state PDA (BPC157)      : ${output.addresses.peg_state_pda_bpc157}`);
  console.log(`  $bBPC157 mint               : ${output.addresses.peptide_token_mint_bpc157}`);
  console.log("");
  if (output.transactions.length > 0) {
    console.log("  Transactions:");
    for (const tx of output.transactions) {
      console.log(`    step ${tx.step}  ${tx.name}`);
      console.log(`            ${tx.signature}`);
      console.log(`            ${tx.solscan}`);
    }
    console.log("");
  }
  console.log(`  Output saved to: ${cli.outputPath}`);
  if (output.addresses.peptide_token_mint_bpc157 && !cli.dryRun) {
    console.log(`  $bBPC157 mint keypair: ${cli.mintKeypairPath} (KEEP SECURE)`);
  }
  console.log("");
  if (!cli.dryRun) {
    console.log("  Next steps:");
    console.log("    1. Update apps/oracle env on Railway:");
    console.log("       PEG_PUSHER_ENABLED=true");
    console.log(`       PEG_PROGRAM_ID=${output.program_id}`);
    console.log("       PEG_PEPTIDES=BPC157");
    console.log("    2. Update biohash.network frontend constants:");
    console.log(`       PEG_STATE    = "${output.addresses.peg_state_pda_bpc157 ?? ""}"`);
    console.log(`       PEPTIDE_MINT = "${output.addresses.peptide_token_mint_bpc157 ?? ""}"`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api-key")) {
      u.searchParams.set("api-key", "***");
    }
    return u.toString();
  } catch {
    return url;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`\n[fatal] ${msg}\n`);
  process.exit(1);
});
