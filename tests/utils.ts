// Shared test helpers for biohash-peg.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  createAssociatedTokenAccount,
  mintTo,
  setAuthority,
  AuthorityType,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

// We import the IDL types lazily — anchor build emits target/types/biohash_peg.ts.
// The tests import this via require() to avoid TS compile-time failure when
// the IDL hasn't been generated yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BiohashPegProgram = Program<any>;

export const PEPTIDE_CODE_BPC157 = peptideCodeBytes("BPC157");

/**
 * Pad a peptide code string to 16 ASCII bytes (zero-right-padded).
 * Spec §02 §4.1: peptide_code is `[u8; 16]` in PegState.
 */
export function peptideCodeBytes(code: string): Buffer {
  if (code.length > 16) throw new Error(`peptide code "${code}" >16 bytes`);
  const buf = Buffer.alloc(16);
  Buffer.from(code, "ascii").copy(buf);
  return buf;
}

export function pegStatePda(programId: PublicKey, peptideCode: Buffer) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("peg_state"), peptideCode],
    programId,
  );
}

export function reserveStatePda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_state")],
    programId,
  );
}

export function reserveVaultAuthorityPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_vault")],
    programId,
  );
}

/** Airdrop SOL to a keypair until the wallet has at least the requested balance. */
export async function airdropTo(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number,
) {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
}

/** Create a fresh USDC-like SPL Mint with 6 decimals, owned by the payer. */
export async function createMockUsdcMint(
  connection: Connection,
  payer: Keypair,
): Promise<PublicKey> {
  return await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6, // decimals — same as real USDC
  );
}

/**
 * Create a peptide-token mint whose mint authority is the peg_state PDA.
 * Per spec §02 §4.3 we create the mint with a temporary authority then
 * transfer ownership.
 */
export async function createPeptideMintForPda(
  connection: Connection,
  payer: Keypair,
  pdaAuthority: PublicKey,
): Promise<PublicKey> {
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey, // temporary mint authority
    null,
    6,
  );
  await setAuthority(
    connection,
    payer,
    mint,
    payer,
    AuthorityType.MintTokens,
    pdaAuthority,
  );
  return mint;
}

/** Mint USDC to a user's ATA. */
export async function fundUsdc(
  connection: Connection,
  payer: Keypair,
  usdcMint: PublicKey,
  user: PublicKey,
  amount: bigint | number,
): Promise<PublicKey> {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    user,
  );
  await mintTo(connection, payer, usdcMint, ata.address, payer, amount);
  return ata.address;
}

/** Get the SPL token account amount as a bigint. */
export async function tokenAmount(
  connection: Connection,
  ata: PublicKey,
): Promise<bigint> {
  const acct = await getAccount(connection, ata);
  return acct.amount;
}

/**
 * Encode a USD-per-mg TWAP value into the on-chain unit (micro-USDC × 10⁶).
 * Spec §02 §3.3: on_chain_twap = twap_usd_per_mg × 10⁶.
 *
 * Example: 5.998 USD/mg → 5_998_000 (u64).
 */
export function encodeTwap(usdPerMg: number): BN {
  // Multiply with 6 decimal places of precision. Use string math to avoid
  // floating-point drift for cases like 5.998.
  const scaled = Math.round(usdPerMg * 1_000_000);
  return new BN(scaled);
}

/**
 * Sleep until the on-chain slot number has advanced by at least `slots`.
 * Used by staleness tests.
 */
export async function waitForSlots(
  connection: Connection,
  slots: number,
): Promise<void> {
  const startSlot = await connection.getSlot();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const currentSlot = await connection.getSlot();
    if (currentSlot >= startSlot + slots) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Assert that a thenable rejects with an Anchor error matching the given
 * code name (e.g. "TwapStale"). Anchor surfaces these as `error.error.errorCode.code`.
 */
export async function assertAnchorError(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) {
    throw new Error(
      `expected anchor error "${expectedCode}", but call resolved without error`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = caught as any;
  const code = err?.error?.errorCode?.code ?? err?.errorLogs?.join("\n") ?? String(err);
  if (typeof code !== "string" || !code.includes(expectedCode)) {
    throw new Error(
      `expected anchor error "${expectedCode}", got: ${code}\n${err?.stack ?? ""}`,
    );
  }
}
