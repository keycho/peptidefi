/**
 * BioHash $bBPC157 — create Metaplex Token Metadata account.
 *
 *   pnpm tsx scripts/create-token-metadata.ts [flags]
 *
 *   --dry-run   Plan + log only; submit nothing. Default: live.
 *   --yes       Skip the Ctrl+C-in-5s prompt. Default: prompt.
 *   --rpc-url   Override RPC URL. Default: Helius mainnet (HELIUS_API_KEY env).
 *   --output    Output JSON path. Default: scripts/bbpc157-metadata-output.json
 *
 * Calls the peg program's create_token_metadata instruction (added on
 * the bbpc157-metadata branch). The peg program signs as the
 * peg_state PDA via invoke_signed; that's what gives Metaplex the
 * mint authority signature it requires.
 *
 * The metadata's update_authority is set to PEG_DEPLOYER_KEYPAIR — the
 * same wallet that pays for the metadata account creation. After
 * creation, the deployer can update name / symbol / URI directly via
 * Metaplex without going through the peg program again.
 *
 * Idempotent: if the metadata account already exists, the script logs
 * the existing signature (from the output JSON if available) and
 * exits 0. The on-chain instruction also reverts on duplicate creation.
 *
 * Hardcoded mainnet constants (CLI cannot override):
 *   - PEG_PROGRAM_ID    2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7
 *   - PEPTIDE_MINT      2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp
 *   - METAPLEX_PID      metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
 *   - PEPTIDE_CODE      "BPC157"
 *
 * Metadata content lives in scripts/bbpc157-metadata.json (the file
 * the operator copies to biohash.network/token-metadata/bbpc157.json).
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";

import idlJson from "./idl/biohash_peg.json" with { type: "json" };

// ─── Constants ─────────────────────────────────────────────────────

const PEG_PROGRAM_ID = new PublicKey(
  "2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7",
);
const PEPTIDE_MINT = new PublicKey(
  "2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp",
);
const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);
const PEPTIDE_CODE = "BPC157";
const MIN_DEPLOYER_BALANCE_SOL = 0.05; // creation rent ~0.0028 SOL + tx fee

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const TOKEN_NAME = "BioHash Pegged BPC-157";
const TOKEN_SYMBOL = "bBPC157";
const TOKEN_URI = "https://biohash.network/token-metadata/bbpc157.json";

const DEFAULT_RPC_URL = "https://mainnet.helius-rpc.com";
const DEFAULT_OUTPUT_PATH = "scripts/bbpc157-metadata-output.json";

const PROMPT_COUNTDOWN_SEC = 5;

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");

// ─── Types ─────────────────────────────────────────────────────────

interface Cli {
  dryRun: boolean;
  yes: boolean;
  rpcUrl: string;
  outputPath: string;
}

interface OutputJson {
  program_id: string;
  cluster: "mainnet-beta";
  started_at: string;
  deployer: string | null;
  addresses: Partial<{
    peg_state_pda: string;
    peptide_token_mint: string;
    metadata_account: string;
  }>;
  metadata: {
    name: string;
    symbol: string;
    uri: string;
  };
  transaction: {
    signature: string;
    timestamp: string;
    solscan: string;
  } | null;
}

// ─── CLI ───────────────────────────────────────────────────────────

function parseCli(): Cli {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "rpc-url": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const heliusKey = process.env.HELIUS_API_KEY;
  const defaultRpc = heliusKey
    ? `${DEFAULT_RPC_URL}/?api-key=${heliusKey}`
    : DEFAULT_RPC_URL;

  return {
    dryRun: Boolean(values["dry-run"]),
    yes: Boolean(values.yes),
    rpcUrl: values["rpc-url"] ?? defaultRpc,
    outputPath: resolveRepoPath(values.output ?? DEFAULT_OUTPUT_PATH),
  };
}

function resolveRepoPath(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

function printHelp(): void {
  process.stdout.write(`\
BioHash $bBPC157 — create Metaplex Token Metadata account.

USAGE
  pnpm tsx scripts/create-token-metadata.ts [flags]

FLAGS
  --dry-run         Plan + log only; submit nothing.
  --yes             Skip the Ctrl+C-in-5s prompt.
  --rpc-url=URL     Override RPC URL.
  --output=PATH     Output JSON path (default: ${DEFAULT_OUTPUT_PATH}).
  --help            This message.

ENV
  PEG_DEPLOYER_KEYPAIR  path to deployer keypair JSON (required)
  HELIUS_API_KEY        appended to default Helius URL if --rpc-url not set
`);
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

function peptideCodeBytes16(code: string): Buffer {
  const ascii = Buffer.from(code, "ascii");
  if (ascii.length === 0 || ascii.length > 16) {
    throw new Error(`peptide code must be 1-16 ASCII bytes (got ${ascii.length})`);
  }
  const padded = Buffer.alloc(16);
  ascii.copy(padded, 0);
  return padded;
}

function deriveMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  );
  return pda;
}

function derivePegStatePda(programId: PublicKey, code: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("peg_state"), peptideCodeBytes16(code)],
    programId,
  );
  return pda;
}

async function accountExists(conn: Connection, pk: PublicKey): Promise<boolean> {
  const info = await conn.getAccountInfo(pk, "confirmed");
  return info !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirmStep(name: string, cli: Cli): Promise<void> {
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

function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

function solscanAccount(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `https://solscan.io/account/${s}`;
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

function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api-key")) u.searchParams.set("api-key", "***");
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BioHash $bBPC157 — create Token Metadata");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  mode:     ${cli.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  rpc:      ${redactRpc(cli.rpcUrl)}`);
  console.log(`  output:   ${cli.outputPath}`);
  console.log("");

  const deployerPath = process.env.PEG_DEPLOYER_KEYPAIR;
  if (!deployerPath) throw new Error("env PEG_DEPLOYER_KEYPAIR is required");
  const deployer = loadKeypairFile(deployerPath);

  console.log(`  deployer:        ${deployer.publicKey.toBase58()}`);
  console.log(`  peg program:     ${PEG_PROGRAM_ID.toBase58()}`);
  console.log(`  peptide mint:    ${PEPTIDE_MINT.toBase58()}`);
  console.log(`  metaplex prog:   ${METAPLEX_PROGRAM_ID.toBase58()}`);
  console.log("");
  console.log(`  metadata.name:   "${TOKEN_NAME}"`);
  console.log(`  metadata.symbol: "${TOKEN_SYMBOL}"`);
  console.log(`  metadata.uri:    ${TOKEN_URI}`);
  console.log("");

  const connection = new Connection(cli.rpcUrl, "confirmed");

  // Cluster guard.
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `connected to non-mainnet cluster (genesis=${genesis}); refusing to proceed`,
    );
  }
  console.log(`  cluster guard:   ✓ mainnet-beta (genesis=${genesis.slice(0, 8)}…)`);

  // Program-deployed guard.
  const programInfo = await connection.getAccountInfo(PEG_PROGRAM_ID, "confirmed");
  if (!programInfo) {
    throw new Error(`peg program ${PEG_PROGRAM_ID.toBase58()} not found at this RPC`);
  }
  if (!programInfo.executable) {
    throw new Error(`peg program ${PEG_PROGRAM_ID.toBase58()} is not executable`);
  }
  console.log(`  program guard:   ✓ deployed + executable`);

  // Mint guard — peg_state PDA must be the mint authority for the
  // CPI to succeed inside the program.
  const pegStatePda = derivePegStatePda(PEG_PROGRAM_ID, PEPTIDE_CODE);
  const mintInfo = await connection.getAccountInfo(PEPTIDE_MINT, "confirmed");
  if (!mintInfo) {
    throw new Error(`peptide mint ${PEPTIDE_MINT.toBase58()} not found`);
  }
  console.log(`  peg_state PDA:   ${pegStatePda.toBase58()}`);

  // Deployer balance gate.
  const deployerLamports = await connection.getBalance(deployer.publicKey, "confirmed");
  console.log(`  deployer balance: ${lamportsToSol(deployerLamports)} SOL`);
  if (deployerLamports < MIN_DEPLOYER_BALANCE_SOL * 1e9) {
    throw new Error(
      `deployer balance ${lamportsToSol(deployerLamports)} SOL < ` +
        `${MIN_DEPLOYER_BALANCE_SOL} SOL minimum`,
    );
  }
  console.log("");

  // Metadata PDA derivation + idempotency check.
  const metadataPda = deriveMetadataPda(PEPTIDE_MINT);
  console.log(`  metadata PDA:    ${metadataPda.toBase58()}`);

  if (await accountExists(connection, metadataPda)) {
    const prior = await loadOutput(cli.outputPath);
    if (prior?.transaction?.signature) {
      console.log(
        `  ✓ metadata account already exists (sig=${prior.transaction.signature})`,
      );
      console.log(`    ${prior.transaction.solscan}`);
    } else {
      console.log(
        "  ✓ metadata account already exists (no signature in output JSON)",
      );
      console.log(`    ${solscanAccount(metadataPda)}`);
    }
    console.log("\n  Nothing to do. Exit 0.");
    return;
  }
  console.log(`  metadata exists: ✗ — will create`);
  console.log("");

  // Build the program client.
  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idlJson as Idl, provider);
  // Cast methods for dynamic IDL access (no per-program TS types
  // generated by anchor build, so the typed builder doesn't expose
  // `createTokenMetadata` by name).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;

  // Initialise output journal.
  const output: OutputJson = (await loadOutput(cli.outputPath)) ?? {
    program_id: PEG_PROGRAM_ID.toBase58(),
    cluster: "mainnet-beta",
    started_at: new Date().toISOString(),
    deployer: deployer.publicKey.toBase58(),
    addresses: {},
    metadata: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: TOKEN_URI },
    transaction: null,
  };
  output.addresses.peg_state_pda = pegStatePda.toBase58();
  output.addresses.peptide_token_mint = PEPTIDE_MINT.toBase58();
  output.addresses.metadata_account = metadataPda.toBase58();
  if (!cli.dryRun) await writeOutput(cli.outputPath, output);

  await confirmStep("create_token_metadata", cli);

  if (cli.dryRun) {
    console.log("  [dry-run] skipping submit");
    console.log("");
    console.log("Done (dry-run).");
    return;
  }

  const sig: string = await methods
    .createTokenMetadata(TOKEN_NAME, TOKEN_SYMBOL, TOKEN_URI)
    .accounts({
      payer: deployer.publicKey,
      pegState: pegStatePda,
      peptideTokenMint: PEPTIDE_MINT,
      metadata: metadataPda,
      tokenMetadataProgram: METAPLEX_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log(`\n  signature: ${sig}`);
  console.log(`  solscan:   ${solscanTx(sig)}`);

  output.transaction = {
    signature: sig,
    timestamp: new Date().toISOString(),
    solscan: solscanTx(sig),
  };
  await writeOutput(cli.outputPath, output);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  metadata account: ${metadataPda.toBase58()}`);
  console.log(`  on Solscan:       ${solscanAccount(metadataPda)}`);
  console.log(`  tx:               ${solscanTx(sig)}`);
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Host the metadata JSON file:");
  console.log(`       ${TOKEN_URI}");`);
  console.log("       (copy scripts/bbpc157-metadata.json into the frontend repo's");
  console.log("        public/token-metadata/bbpc157.json).");
  console.log("    2. Host the logo at:");
  console.log("       https://biohash.network/assets/bbpc157-logo.svg");
  console.log("       (copy scripts/bbpc157-logo.svg into the frontend repo's");
  console.log("        public/assets/).");
  console.log("    3. Wait ~5 minutes, then check Phantom / Solscan — they fetch");
  console.log("       the metadata + image lazily; the on-chain name/symbol is");
  console.log("       immediate, the image takes a fetch round-trip.");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`\n[fatal] ${msg}\n`);
  process.exit(1);
});
