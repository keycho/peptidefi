/**
 * BioHash Peptide Index program — integration tests.
 *
 * Seven cases pinning the program's contract:
 *
 *   1. initialize happy path
 *   2. initialize fails when called twice
 *   3. update happy path emits IndexUpdated
 *   4. update rejects when signer != stored authority
 *   5. update rejects replay (hour_start_unix equal to current)
 *   6. update rejects out-of-order (hour_start_unix less than current)
 *   7. update accepts strictly-greater hour_start_unix
 *
 * Runs against `solana-test-validator` spun up by `anchor test`. The
 * provider wallet at ~/.config/solana/id.json is the authority on the
 * happy paths; a fresh ephemeral keypair is the wrong-authority signer
 * in case (4).
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";
import type { BiohashIndexProgram } from "../target/types/biohash_index_program";

type Program<T extends anchor.Idl> = anchor.Program<T>;

/** Same seed bytes as `INDEX_SEED_PREFIX` + `INDEX_VERSION_SEED` in the program. */
const INDEX_SEED_PREFIX = Buffer.from("peptide_index");
const INDEX_VERSION_SEED = Buffer.from("v1");

/** Fixture values used across cases. Anything tied to a baseline epoch
 *  uses 2026-05-03T00:00:00Z = 1778889600 unix seconds. */
const BASELINE_LEVEL = new BN(10_000_000); // 1000.0000 at 4 decimals
const BASELINE_TIMESTAMP = new BN(1_778_889_600);
const COHORT_SIZE = 29;

const ZERO_HASH = new Uint8Array(32);
const HASH_A = new Uint8Array(32).fill(0xaa);
const HASH_B = new Uint8Array(32).fill(0xbb);

describe("biohash_index_program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.biohashIndexProgram as Program<BiohashIndexProgram>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let indexPda: PublicKey;

  before(async () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [INDEX_SEED_PREFIX, INDEX_VERSION_SEED],
      program.programId,
    );
    indexPda = pda;
  });

  /**
   * (1) Initialize happy path.
   *
   * Verifies the PDA gets allocated with the documented field values,
   * the bump is recorded, and Clock-driven fields land in a plausible
   * range.
   */
  it("initializes the index account at the v1 PDA", async () => {
    const beforeSlot = await provider.connection.getSlot();

    await program.methods
      .initializeIndexAccount(BASELINE_LEVEL, BASELINE_TIMESTAMP, COHORT_SIZE)
      .accounts({
        authority: authority.publicKey,
        indexAccount: indexPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const acc = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(acc.version).to.equal(1);
    expect(acc.cohortSize).to.equal(COHORT_SIZE);
    expect(acc.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(acc.baselineLevel.toString()).to.equal(BASELINE_LEVEL.toString());
    expect(acc.baselineTimestamp.toString()).to.equal(BASELINE_TIMESTAMP.toString());
    expect(acc.indexLevel.toString()).to.equal(BASELINE_LEVEL.toString());
    expect(acc.hourStartUnix.toString()).to.equal(BASELINE_TIMESTAMP.toString());
    expect(Array.from(acc.componentsHash as Buffer)).to.deep.equal(Array.from(ZERO_HASH));
    expect(acc.lastUpdateSlot.toNumber()).to.be.at.least(beforeSlot);
    expect(acc.lastUpdateTimestamp.toNumber()).to.be.greaterThan(0);
    // _pad and _reserved are inaccessible from the IDL surface; reading
    // raw account data would suffice but the field-by-field positives
    // above pin everything that matters operationally.
  });

  /**
   * (2) Initialize fails on re-run.
   *
   * Anchor's `init` constraint allocates the PDA via the system program;
   * a second attempt fails because the account already exists. The
   * exact error is `AccountAlreadyInitialized` at the Anchor layer
   * (which surfaces as the system-program "account already in use"
   * preflight error on web3.js, plus the Anchor 0x0 system-error code).
   * We just assert that the second call throws.
   */
  it("fails if initialize_index_account is called twice", async () => {
    let threw = false;
    try {
      await program.methods
        .initializeIndexAccount(BASELINE_LEVEL, BASELINE_TIMESTAMP, COHORT_SIZE)
        .accounts({
          authority: authority.publicKey,
          indexAccount: indexPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();
    } catch (err) {
      threw = true;
    }
    expect(threw, "second initialize must throw").to.equal(true);
  });

  /**
   * (3) Update happy path, with event emission.
   *
   * Subscribes to IndexUpdated, sends an update, asserts the new
   * level and components_hash land on-chain, and asserts the event
   * payload matches.
   */
  it("update_index writes new values and emits IndexUpdated", async () => {
    const newLevel = new BN(10_500_000); // +5%
    const newHour = BASELINE_TIMESTAMP.add(new BN(3600)); // +1h

    const before = await program.account.peptideIndexAccount.fetch(indexPda);
    const previousLevel = before.indexLevel;

    let captured: anchor.Event<typeof program["idl"]["events"][number]> | null = null;
    const listener = program.addEventListener("indexUpdated", (event) => {
      captured = event;
    });

    try {
      await program.methods
        .updateIndex(newLevel, newHour, Array.from(HASH_A) as any)
        .accounts({
          authority: authority.publicKey,
          indexAccount: indexPda,
        } as any)
        .rpc();
    } finally {
      // small delay so the websocket event arrives before we
      // remove the listener.
      await new Promise((r) => setTimeout(r, 1500));
      await program.removeEventListener(listener);
    }

    const after = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(after.indexLevel.toString()).to.equal(newLevel.toString());
    expect(after.hourStartUnix.toString()).to.equal(newHour.toString());
    expect(Array.from(after.componentsHash as Buffer)).to.deep.equal(Array.from(HASH_A));
    expect(after.lastUpdateSlot.toNumber()).to.be.greaterThan(before.lastUpdateSlot.toNumber());

    assert.isNotNull(captured, "IndexUpdated event must have fired");
    const ev = captured as any;
    expect(ev.previousLevel.toString()).to.equal(previousLevel.toString());
    expect(ev.newLevel.toString()).to.equal(newLevel.toString());
    expect(ev.hourStartUnix.toString()).to.equal(newHour.toString());
    expect(Array.from(ev.componentsHash as Buffer)).to.deep.equal(Array.from(HASH_A));
  });

  /**
   * (4) Update rejects wrong authority.
   *
   * `has_one = authority` causes the program to reject any signer
   * whose pubkey doesn't match the stored authority.
   */
  it("update_index rejects a signer that is not the stored authority", async () => {
    const intruder = Keypair.generate();
    // Fund the intruder so the tx can pay its base fee.
    const sig = await provider.connection.requestAirdrop(
      intruder.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    const before = await program.account.peptideIndexAccount.fetch(indexPda);
    const evenLaterHour = before.hourStartUnix.add(new BN(3600));

    let threw = false;
    try {
      await program.methods
        .updateIndex(new BN(99_999_999), evenLaterHour, Array.from(HASH_B) as any)
        .accounts({
          authority: intruder.publicKey,
          indexAccount: indexPda,
        } as any)
        .signers([intruder])
        .rpc();
    } catch (err) {
      threw = true;
      // The has_one violation maps to Anchor error code ConstraintHasOne.
      const msg = (err as Error).message ?? String(err);
      expect(msg).to.match(/ConstraintHasOne|HasOne|has[ _]one/i);
    }
    expect(threw, "wrong-authority update must throw").to.equal(true);

    // State unchanged.
    const after = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(after.indexLevel.toString()).to.equal(before.indexLevel.toString());
    expect(after.hourStartUnix.toString()).to.equal(before.hourStartUnix.toString());
  });

  /**
   * (5) Update rejects replay (equal hour_start_unix).
   *
   * Strict greater-than means hour_start_unix == account.hour_start_unix
   * is rejected. Catches a stuck poller that re-submits the same hour.
   */
  it("update_index rejects when hour_start_unix equals the stored value", async () => {
    const before = await program.account.peptideIndexAccount.fetch(indexPda);
    const sameHour = before.hourStartUnix;

    let threw = false;
    try {
      await program.methods
        .updateIndex(new BN(10_900_000), sameHour, Array.from(HASH_B) as any)
        .accounts({
          authority: authority.publicKey,
          indexAccount: indexPda,
        } as any)
        .rpc();
    } catch (err) {
      threw = true;
      const msg = (err as Error).message ?? String(err);
      expect(msg).to.match(/NonMonotonicHour|strictly greater/i);
    }
    expect(threw, "equal-hour update must throw").to.equal(true);

    const after = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(after.indexLevel.toString()).to.equal(before.indexLevel.toString());
  });

  /**
   * (6) Update rejects out-of-order (hour_start_unix less than current).
   *
   * Same strict check rejects a hour earlier than what's stored.
   * Critical for the startup-recovery batch path: if hours arrive in
   * the wrong order, the program is the canonical guard.
   */
  it("update_index rejects when hour_start_unix is less than the stored value", async () => {
    const before = await program.account.peptideIndexAccount.fetch(indexPda);
    const earlierHour = before.hourStartUnix.sub(new BN(3600));

    let threw = false;
    try {
      await program.methods
        .updateIndex(new BN(10_900_000), earlierHour, Array.from(HASH_B) as any)
        .accounts({
          authority: authority.publicKey,
          indexAccount: indexPda,
        } as any)
        .rpc();
    } catch (err) {
      threw = true;
      const msg = (err as Error).message ?? String(err);
      expect(msg).to.match(/NonMonotonicHour|strictly greater/i);
    }
    expect(threw, "earlier-hour update must throw").to.equal(true);

    const after = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(after.indexLevel.toString()).to.equal(before.indexLevel.toString());
  });

  /**
   * (7) Update accepts strictly-greater hour_start_unix.
   *
   * Mirror of (5) and (6) on the happy side. After the rejections above
   * an even-later hour should still land cleanly, proving the previous
   * failed attempts left no residue.
   */
  it("update_index accepts a strictly-greater hour_start_unix", async () => {
    const before = await program.account.peptideIndexAccount.fetch(indexPda);
    const laterHour = before.hourStartUnix.add(new BN(7200)); // +2h
    const newLevel = new BN(11_000_000);

    await program.methods
      .updateIndex(newLevel, laterHour, Array.from(HASH_B) as any)
      .accounts({
        authority: authority.publicKey,
        indexAccount: indexPda,
      } as any)
      .rpc();

    const after = await program.account.peptideIndexAccount.fetch(indexPda);
    expect(after.indexLevel.toString()).to.equal(newLevel.toString());
    expect(after.hourStartUnix.toString()).to.equal(laterHour.toString());
    expect(Array.from(after.componentsHash as Buffer)).to.deep.equal(Array.from(HASH_B));
  });
});
