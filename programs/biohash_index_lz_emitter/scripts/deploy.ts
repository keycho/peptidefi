/**
 * BioHash index LZ emitter - one-shot mainnet initialisation.
 *
 *   pnpm tsx programs/biohash_index_lz_emitter/scripts/deploy.ts \
 *     [--dry-run] [--yes] [--rpc-url=URL]
 *
 * Steps (all idempotent - re-running after partial failure is safe):
 *
 *   1. init_oapp_store(endpoint_program)
 *      Creates the OApp store PDA, sets the authority + endpoint.
 *
 *   2. init_peer(dst_eid=30184, peer_address=<Base mirror contract>)
 *      Records the Base mirror as the trusted peer for Base mainnet.
 *
 *   3. Configure LayerZero send/receive libraries + DVN + executor
 *      via the LayerZero endpoint's set_*_library and set_*_config
 *      instructions. This is SDK territory; the strawman calls out
 *      the operations and leaves the exact instructions as TODO.
 *
 * Safety rails (mirroring scripts/initialize-peg-mainnet.ts):
 *
 *   - Genesis-hash guard: connection must point at mainnet-beta.
 *   - Program-deployed guard: getAccountInfo(programId) returns a
 *     non-null executable account.
 *   - Authority balance gate: ≥ 0.5 SOL before any submission.
 *   - Per-step Ctrl+C-in-5s prompt unless --yes.
 *   - Pre-flight: refuses to proceed if the Base contract address
 *     argument is the zero address.
 *
 * Env vars:
 *
 *   ORACLE_AUTHORITY_KEYPAIR     path to oracle authority keypair JSON (required)
 *   LZ_EMITTER_PROGRAM_ID        deployed program ID (required)
 *   LZ_ENDPOINT_PROGRAM_ID       LayerZero V2 endpoint program on Solana (required)
 *   LZ_BASE_PEER_ADDRESS         Base contract address, 0x-prefixed hex (required)
 *   LZ_BASE_ENDPOINT_ID          LayerZero destination EID, default 30184 (Base mainnet)
 *   HELIUS_API_KEY               optional; appended to the default Helius URL
 *
 * Output:
 *
 *   programs/biohash_index_lz_emitter/scripts/init-output.json (gitignored)
 *
 * Strawman caveats:
 *
 * The LayerZero endpoint configuration (send library, receive
 * library, DVN, executor) is not yet implemented in this script.
 * Once the SDK choice is locked, add a step 3 that issues the
 * LayerZero endpoint instructions to wire up the libraries and the
 * single-DVN configuration (LayerZero Labs DVN for v1).
 *
 * Run with --dry-run first against mainnet to confirm the addresses
 * derive correctly and the existing on-chain state matches expectation.
 * Only invoke without --dry-run after a successful dry-run + manual
 * review of the output.
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  AnchorProvider,
  Program,
  Wallet,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import idlJson from "../../../apps/oracle/src/lz/idl.json" with { type: "json" };

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEFAULT_RPC_URL = "https://mainnet.helius-rpc.com";
const DEFAULT_BASE_EID = 30184;
const MIN_AUTHORITY_BALANCE_SOL = 0.5;
const PROMPT_COUNTDOWN_SEC = 5;

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_OUTPUT_PATH = resolve(
  SCRIPT_DIR,
  "init-output.json",
);

interface Cli {
  dryRun: boolean;
  yes: boolean;
  rpcUrl: string;
  outputPath: string;
  help: boolean;
}

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

  const heliusKey = process.env.HELIUS_API_KEY;
  const defaultRpc = heliusKey
    ? `${DEFAULT_RPC_URL}/?api-key=${heliusKey}`
    : DEFAULT_RPC_URL;

  return {
    dryRun: Boolean(values["dry-run"]),
    yes: Boolean(values.yes),
    rpcUrl: values["rpc-url"] ?? defaultRpc,
    outputPath: values.output
      ? isAbsolute(values.output) ? values.output : resolve(REPO_ROOT, values.output)
      : DEFAULT_OUTPUT_PATH,
    help: Boolean(values.help),
  };
}

function printHelp(): void {
  process.stdout.write(`\
BioHash index LZ emitter - one-shot mainnet initialisation.

USAGE
  pnpm tsx programs/biohash_index_lz_emitter/scripts/deploy.ts [flags]

FLAGS
  --dry-run             Plan + log only; submit nothing.
  --yes                 Skip the per-step Ctrl+C-in-5s prompt.
  --rpc-url=URL         Override the RPC URL.
  --output=PATH         Output JSON path (default: scripts/init-output.json).
  --help                This message.

ENV
  ORACLE_AUTHORITY_KEYPAIR     path to oracle authority keypair JSON  (required)
  LZ_EMITTER_PROGRAM_ID        deployed program ID                    (required)
  LZ_ENDPOINT_PROGRAM_ID       LayerZero V2 endpoint on Solana        (required)
  LZ_BASE_PEER_ADDRESS         Base contract 0x address               (required)
  LZ_BASE_ENDPOINT_ID          destination EID, default ${DEFAULT_BASE_EID}
  HELIUS_API_KEY               appended to default Helius URL if --rpc-url not set
`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`env ${name} is required`);
  }
  return v.trim();
}

function loadKeypairFile(p: string): Keypair {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const raw = require("node:fs").readFileSync(p, "utf-8");
  const arr = JSON.parse(raw) as number[];
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(
      `keypair file ${p} must be a JSON array of 64 bytes (got ${
        Array.isArray(arr) ? `length ${arr.length}` : typeof arr
      })`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

/** Convert a hex address like 0xabcd... to a 32-byte left-padded array. */
function hexAddressToBytes32(hex: string): number[] {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(
      `peer address must be a 20-byte (40 hex char) EVM address: ${hex}`,
    );
  }
  const padded = clean.padStart(64, "0");
  const out = new Array<number>(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  if (out.every((b) => b === 0)) {
    throw new Error("refusing to use the zero address as a peer");
  }
  return out;
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

interface OutputJson {
  program_id: string;
  cluster: "mainnet-beta";
  started_at: string;
  authority: string;
  endpoint_program: string;
  base_eid: number;
  base_peer_hex: string;
  addresses: Partial<{
    oapp_store_pda: string;
    peer_pda: string;
  }>;
  transactions: Array<{
    step: number;
    name: string;
    signature: string;
    timestamp: string;
    solscan: string;
  }>;
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (cli.help) {
    printHelp();
    return;
  }

  const authorityKpPath = requireEnv("ORACLE_AUTHORITY_KEYPAIR");
  const programIdStr = requireEnv("LZ_EMITTER_PROGRAM_ID");
  const endpointIdStr = requireEnv("LZ_ENDPOINT_PROGRAM_ID");
  const basePeerHex = requireEnv("LZ_BASE_PEER_ADDRESS");
  const baseEid = Number(process.env.LZ_BASE_ENDPOINT_ID ?? DEFAULT_BASE_EID);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BioHash index LZ emitter - mainnet initialisation");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  mode:                 ${cli.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  rpc:                  ${cli.rpcUrl}`);
  console.log(`  program id:           ${programIdStr}`);
  console.log(`  endpoint program:     ${endpointIdStr}`);
  console.log(`  base eid:             ${baseEid}`);
  console.log(`  base peer (hex):      ${basePeerHex}`);
  console.log("");

  const authority = loadKeypairFile(authorityKpPath);
  console.log(`  authority:            ${authority.publicKey.toBase58()}`);

  const programId = new PublicKey(programIdStr);
  const endpointProgram = new PublicKey(endpointIdStr);
  const peerBytes = hexAddressToBytes32(basePeerHex);

  const connection = new Connection(cli.rpcUrl, "confirmed");

  // Genesis-hash guard.
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new Error(
      `connected to non-mainnet cluster (genesis=${genesis}); refusing to proceed. ` +
        `Mainnet genesis is ${MAINNET_GENESIS_HASH}.`,
    );
  }
  console.log(`  cluster guard:        ✓ mainnet-beta`);

  // Program-deployed guard.
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (!programInfo || !programInfo.executable) {
    throw new Error(
      `emitter program ${programId.toBase58()} not deployed or not executable`,
    );
  }
  console.log(`  program guard:        ✓ deployed + executable`);

  // Authority balance gate.
  const bal = await connection.getBalance(authority.publicKey, "confirmed");
  console.log(`  authority balance:    ${(bal / 1e9).toFixed(6)} SOL`);
  if (bal < MIN_AUTHORITY_BALANCE_SOL * 1e9) {
    throw new Error(
      `authority balance ${(bal / 1e9).toFixed(6)} SOL < ` +
        `${MIN_AUTHORITY_BALANCE_SOL} SOL minimum`,
    );
  }
  console.log("");

  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idlJson as Idl, provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;

  // Derive PDAs.
  const [oappStorePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oapp_store")],
    programId,
  );
  const dstEidBytes = Buffer.alloc(4);
  dstEidBytes.writeUInt32LE(baseEid, 0);
  const [peerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("Peer"), oappStorePda.toBuffer(), dstEidBytes],
    programId,
  );

  console.log("  derived addresses:");
  console.log(`    oapp_store PDA:  ${oappStorePda.toBase58()}`);
  console.log(`    peer PDA:        ${peerPda.toBase58()}`);
  console.log("");

  const output: OutputJson = {
    program_id: programId.toBase58(),
    cluster: "mainnet-beta",
    started_at: new Date().toISOString(),
    authority: authority.publicKey.toBase58(),
    endpoint_program: endpointProgram.toBase58(),
    base_eid: baseEid,
    base_peer_hex: basePeerHex,
    addresses: {
      oapp_store_pda: oappStorePda.toBase58(),
      peer_pda: peerPda.toBase58(),
    },
    transactions: [],
  };

  // ── Step 1: init_oapp_store ─────────────────────────────────────
  console.log("─── Step 1 - init_oapp_store ───────────────────────────────");
  const oappExists = (await connection.getAccountInfo(oappStorePda)) !== null;
  if (oappExists) {
    console.log("  oapp_store already exists; skipping submit.");
  } else {
    await confirmStep("init_oapp_store", cli);
    if (!cli.dryRun) {
      const sig: string = await methods
        .initOappStore(endpointProgram)
        .accounts({
          authority: authority.publicKey,
          oappStore: oappStorePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      output.transactions.push({
        step: 1,
        name: "init_oapp_store",
        signature: sig,
        timestamp: new Date().toISOString(),
        solscan: `https://solscan.io/tx/${sig}`,
      });
      console.log(`  signature: ${sig}`);
    } else {
      console.log("  [dry-run] skipping submit");
    }
  }
  console.log("");

  // ── Step 2: init_peer ───────────────────────────────────────────
  console.log("─── Step 2 - init_peer ─────────────────────────────────────");
  await confirmStep("init_peer", cli);
  if (!cli.dryRun) {
    const sig: string = await methods
      .initPeer(baseEid, peerBytes)
      .accounts({
        authority: authority.publicKey,
        oappStore: oappStorePda,
        peer: peerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    output.transactions.push({
      step: 2,
      name: "init_peer",
      signature: sig,
      timestamp: new Date().toISOString(),
      solscan: `https://solscan.io/tx/${sig}`,
    });
    console.log(`  signature: ${sig}`);
  } else {
    console.log("  [dry-run] skipping submit");
  }
  console.log("");

  // ── Step 3: LayerZero library + DVN config ──────────────────────
  console.log("─── Step 3 - LayerZero send/receive library + DVN config ───");
  console.log("  TODO: issue the LayerZero endpoint instructions that wire");
  console.log("  the OApp to the ULN302 send/receive libraries and configure");
  console.log("  LayerZero Labs DVN as the sole DVN for v1, plus the default");
  console.log("  executor. Reference:");
  console.log("    https://docs.layerzero.network/v2/developers/solana");
  console.log("  Strawman: skipped. Add before first emit.");
  console.log("");

  // ── Write output ────────────────────────────────────────────────
  if (!cli.dryRun) {
    await fs.mkdir(dirname(cli.outputPath), { recursive: true });
    await fs.writeFile(cli.outputPath, JSON.stringify(output, null, 2) + "\n");
    console.log(`  output written to: ${cli.outputPath}`);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DONE - set the following on Railway oracle service:");
  console.log(`    ORACLE_LZ_EMITTER_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`    ORACLE_LZ_ENDPOINT_PROGRAM_ID=${endpointProgram.toBase58()}`);
  console.log(`    ORACLE_LZ_BASE_ENDPOINT_ID=${baseEid}`);
  console.log(`    ORACLE_LZ_BASE_PEER_ADDRESS=${basePeerHex}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`\n[fatal] ${msg}\n`);
  process.exit(1);
});
