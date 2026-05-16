/**
 * One-shot initialisation for the BioHash Peptide Index on-chain
 * account (schema 1.1).
 *
 * Calls `initialize_index_account(baseline_level, baseline_timestamp,
 * cohort_size)` on the singleton PDA derived from
 * `["peptide_index", "v1"]`. Idempotent at the on-chain layer (the
 * program's `init` constraint rejects re-runs with
 * AccountAlreadyInitialized); this script additionally short-circuits
 * before submission if the PDA already has a rent-exempt account.
 *
 * Usage (devnet):
 *   ORACLE_INDEX_PROGRAM_ID=<program-id-from-anchor-deploy> \
 *   ORACLE_SOLANA_PRIVATE_KEY=<bs58 64-byte secret> \
 *   ORACLE_RPC_URL=https://api.devnet.solana.com \
 *   pnpm tsx apps/oracle/scripts/initialize-index-account.ts [--dry-run]
 *
 * Locked v1 constants (per design doc v2):
 *
 *   baseline_level       10_000_000   (1000.0000 at 4 decimals)
 *   baseline_timestamp   1_778_889_600  (2026-05-03T00:00:00Z unix sec)
 *   cohort_size          29
 *
 * Fails loudly if:
 *   - ORACLE_INDEX_PROGRAM_ID is unset
 *   - The program at programId is not deployed (no executable account)
 *   - The PDA already exists (use the on-chain account; don't re-init)
 *   - The signer's wallet balance is below 0.05 SOL
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';

import idlJson from '../src/index/idl.json' with { type: 'json' };

const INDEX_SEED_PREFIX = Buffer.from('peptide_index');
const INDEX_VERSION_SEED = Buffer.from('v1');

const BASELINE_LEVEL = new BN(10_000_000);
const BASELINE_TIMESTAMP = new BN(1_778_889_600);
const COHORT_SIZE = 29;

const MIN_BALANCE_SOL = 0.05;

interface CliOpts {
  dryRun: boolean;
}

function parseCli(): CliOpts {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return { dryRun: !!values['dry-run'] };
}

async function main(): Promise<void> {
  const opts = parseCli();

  const programIdRaw = process.env.ORACLE_INDEX_PROGRAM_ID?.trim();
  if (!programIdRaw) {
    fail('ORACLE_INDEX_PROGRAM_ID is required');
  }
  const programId = new PublicKey(programIdRaw);

  const secretRaw = process.env.ORACLE_SOLANA_PRIVATE_KEY?.trim();
  if (!secretRaw) {
    fail('ORACLE_SOLANA_PRIVATE_KEY is required (bs58-encoded 64-byte secret)');
  }
  let secret: Uint8Array;
  try {
    secret = bs58.decode(secretRaw);
  } catch (err) {
    fail(`ORACLE_SOLANA_PRIVATE_KEY is not valid base58: ${(err as Error).message}`);
  }
  if (secret.length !== 64) {
    fail(`ORACLE_SOLANA_PRIVATE_KEY decoded to ${secret.length} bytes; expected 64`);
  }
  const authority = Keypair.fromSecretKey(secret);

  const rpcUrl = process.env.ORACLE_RPC_URL?.trim();
  if (!rpcUrl) {
    fail('ORACLE_RPC_URL is required');
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log(`[init-index] cluster RPC: ${rpcUrl}`);
  console.log(`[init-index] program id:  ${programId.toBase58()}`);
  console.log(`[init-index] authority:   ${authority.publicKey.toBase58()}`);

  // Program-deployed guard.
  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo) {
    fail(`program ${programId.toBase58()} not found on this cluster`);
  }
  if (!programInfo.executable) {
    fail(`account ${programId.toBase58()} exists but is not executable`);
  }
  console.log(`[init-index] program is deployed and executable`);

  // PDA derivation + existence check.
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [INDEX_SEED_PREFIX, INDEX_VERSION_SEED],
    programId,
  );
  console.log(`[init-index] index PDA:   ${pda.toBase58()} (bump=${bump})`);

  const pdaInfo = await connection.getAccountInfo(pda);
  if (pdaInfo) {
    fail(
      `PDA ${pda.toBase58()} already exists (${pdaInfo.data.length} bytes, ` +
        `owner=${pdaInfo.owner.toBase58()}). Refusing to re-initialise.`,
    );
  }
  console.log(`[init-index] PDA does not exist; will allocate`);

  // Balance gate.
  const balanceLamports = await connection.getBalance(authority.publicKey);
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
  console.log(`[init-index] authority balance: ${balanceSol.toFixed(6)} SOL`);
  if (balanceSol < MIN_BALANCE_SOL) {
    fail(
      `authority balance ${balanceSol.toFixed(6)} SOL is below the required ` +
        `${MIN_BALANCE_SOL} SOL minimum (rent + tx fee).`,
    );
  }

  if (opts.dryRun) {
    console.log('[init-index] --dry-run: skipping submission');
    console.log(
      `[init-index] would call initialize_index_account(` +
        `baseline_level=${BASELINE_LEVEL.toString()}, ` +
        `baseline_timestamp=${BASELINE_TIMESTAMP.toString()}, ` +
        `cohort_size=${COHORT_SIZE})`,
    );
    return;
  }

  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new Program(idlJson as Idl, provider);

  console.log(`[init-index] submitting initialize_index_account...`);
  const sig = await program.methods
    .initializeIndexAccount(BASELINE_LEVEL, BASELINE_TIMESTAMP, COHORT_SIZE)
    .accounts({
      authority: authority.publicKey,
      indexAccount: pda,
      systemProgram: SystemProgram.programId,
    } as never)
    .rpc();
  console.log(`[init-index] submitted: ${sig}`);

  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`[init-index] confirmed`);

  const after = await connection.getAccountInfo(pda);
  if (!after) {
    fail('confirmation reported success but PDA is still null. Investigate.');
  }
  console.log(
    `[init-index] PDA now exists: ${after.data.length} bytes, ` +
      `owner=${after.owner.toBase58()}, rent-exempt=${after.lamports} lamports`,
  );
  console.log(`[init-index] done`);
}

function fail(msg: string): never {
  console.error(`[init-index] FATAL: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
