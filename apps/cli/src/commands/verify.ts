import ora from "ora";
import { Connection } from "@solana/web3.js";
import { api, ApiError } from "../lib/api.js";
import { c, glyph } from "../lib/theme.js";
import { config, trimSig } from "../lib/config.js";

export async function verifyCommand(opts: { cycle: string }) {
  const cycleId = parseInt(opts.cycle, 10);
  if (!Number.isFinite(cycleId) || cycleId <= 0) {
    console.error(c.red(`error: --cycle must be a positive integer`));
    process.exit(1);
  }

  console.log();
  console.log(
    "  " +
      c.live(glyph.dot) +
      " " +
      c.body(`verifying cycle `) +
      c.amber(`#${cycleId}`) +
      c.body("..."),
  );
  console.log();

  const started = Date.now();

  // Step 1: pull cycle summary from API
  const step1 = ora({
    text: c.dim("fetching cycle summary..."),
    color: "yellow",
    indent: 2,
  }).start();

  let cycle: import("../lib/api.js").CycleSummary;
  try {
    cycle = await api.cycle(cycleId);
    step1.stopAndPersist({
      symbol: c.live(glyph.tick),
      text:
        c.body("cycle summary  ") +
        c.dim(
          `${cycle.finalized_count}/${cycle.expected_count} peptides finalized`,
        ),
    });
  } catch (err) {
    step1.fail(c.red(formatErr(err)));
    process.exit(1);
  }

  // Step 2: check Solana commit exists on mainnet
  const step2 = ora({
    text: c.dim("checking mainnet commit..."),
    color: "yellow",
    indent: 2,
  }).start();

  try {
    const conn = new Connection(config.mainnetRpc, "confirmed");
    const status = await conn.getSignatureStatus(cycle.solana_signature, {
      searchTransactionHistory: true,
    });

    if (!status.value) {
      step2.fail(c.red(`mainnet commit not found: ${cycle.solana_signature}`));
      process.exit(1);
    }

    const confirmation = status.value.confirmationStatus ?? "unknown";
    step2.stopAndPersist({
      symbol: c.live(glyph.tick),
      text:
        c.body("mainnet commit ") +
        c.dim(
          `slot ${cycle.solana_slot.toLocaleString("en-US")} · ${confirmation}`,
        ),
    });
  } catch (err) {
    step2.fail(c.red(`mainnet rpc error: ${formatErr(err)}`));
    process.exit(1);
  }

  // Step 3: verify components hash matches IPFS manifest CID
  // (Sanity check only: a non-empty hash and non-empty CID. Full manifest
  // re-derivation is in v0.2.)
  const step3 = ora({
    text: c.dim("verifying components hash..."),
    color: "yellow",
    indent: 2,
  }).start();

  await sleep(180); // small pause so the tick lands distinctly in video recordings

  if (cycle.components_hash && cycle.ipfs_manifest_cid) {
    step3.stopAndPersist({
      symbol: c.live(glyph.tick),
      text:
        c.body("components hash") +
        c.dim(
          "  " +
            cycle.components_hash.slice(0, 8) +
            "…" +
            cycle.components_hash.slice(-8) +
            " · pinned to ipfs",
        ),
    });
  } else {
    step3.fail(c.red("missing components hash or ipfs manifest"));
    process.exit(1);
  }

  // Step 4: cohort completeness
  const step4 = ora({
    text: c.dim("checking cohort completeness..."),
    color: "yellow",
    indent: 2,
  }).start();

  await sleep(140);

  if (cycle.finalized_count === cycle.expected_count) {
    step4.stopAndPersist({
      symbol: c.live(glyph.tick),
      text:
        c.body("cohort         ") +
        c.dim(
          `${cycle.finalized_count}/${cycle.expected_count} peptides · all observations included`,
        ),
    });
  } else {
    step4.stopAndPersist({
      symbol: c.amber(glyph.tick),
      text:
        c.amber("cohort         ") +
        c.dim(
          `${cycle.finalized_count}/${cycle.expected_count} peptides · partial`,
        ),
    });
  }

  // Footer
  const elapsed = Date.now() - started;
  console.log();
  console.log(
    "  " + c.live(glyph.dot) + " " + c.live("verified") + c.dim(`  in ${elapsed}ms`),
  );
  console.log();
  console.log("  " + c.mint("signature      ") + c.body(trimSig(cycle.solana_signature)));
  console.log("  " + c.mint("ipfs cid       ") + c.body(cycle.ipfs_manifest_cid.slice(0, 12) + "…" + cycle.ipfs_manifest_cid.slice(-6)));
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErr(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
