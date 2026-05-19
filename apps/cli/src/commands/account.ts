import ora from "ora";
import { Connection, PublicKey } from "@solana/web3.js";
import { c, glyph } from "../lib/theme.js";
import { config, fmtLevel, fmtPct, unscale } from "../lib/config.js";

export async function accountCommand(
  pubkey: string,
  opts: { cluster: string },
) {
  const cluster = opts.cluster === "devnet" ? "devnet" : "mainnet-beta";
  const rpc = cluster === "devnet" ? config.devnetRpc : config.mainnetRpc;

  let pk: PublicKey;
  try {
    pk = new PublicKey(pubkey);
  } catch {
    console.error(c.red(`error: "${pubkey}" is not a valid Solana public key`));
    process.exit(1);
  }

  const spinner = ora({
    text: c.dim(`fetching ${pubkey.slice(0, 8)}…${pubkey.slice(-7)} on ${cluster}...`),
    color: "yellow",
  }).start();

  try {
    const conn = new Connection(rpc, "confirmed");
    const info = await conn.getAccountInfo(pk, "confirmed");
    spinner.stop();

    if (!info) {
      console.log();
      console.log(c.red(`  ${glyph.cross} account does not exist on ${cluster}`));
      console.log();
      process.exit(1);
    }

    console.log();
    console.log("  " + c.mint("ACCOUNT       ") + c.amber(pubkey));
    console.log("  " + c.mint("CLUSTER       ") + c.body(cluster));
    console.log("  " + c.mint("OWNER         ") + c.body(info.owner.toBase58()));
    console.log("  " + c.mint("LAMPORTS      ") + c.body(info.lamports.toLocaleString("en-US")));
    console.log("  " + c.mint("SIZE          ") + c.body(`${info.data.length} bytes`));
    console.log("  " + c.mint("EXECUTABLE    ") + c.body(info.executable ? "yes" : "no"));

    // Special case: if this is the BioHash index PDA, decode and pretty-print.
    if (pubkey === config.indexPda) {
      decodeBiohashIndex(info.data);
    }

    console.log();
  } catch (err) {
    spinner.fail(c.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------
// Decoder for the BioHash Peptide Index account
//
// Schema (matches the Anchor program's IndexAccount, total 160 bytes):
//   8   discriminator
//   32  authority pubkey
//   8   baseline_level (u64, scaled by 1e4)
//   8   baseline_timestamp (i64, unix seconds)
//   2   cohort_size (u16)
//   8   last_index_level (u64, scaled by 1e4)
//   8   last_hour_start (i64, unix seconds)
//   32  last_components_hash ([u8; 32])
//   8   last_update_slot (u64)
//   1   bump (u8)
//   45  padding/reserved (to reach 160)
//
// Little-endian for numerics, as per Anchor convention.
// ----------------------------------------------------------------------------

function decodeBiohashIndex(data: Buffer | Uint8Array) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  if (buf.length < 113) {
    console.log();
    console.log(c.red(`  account too small to decode (${buf.length} bytes)`));
    return;
  }

  let offset = 8; // skip discriminator

  const authority = new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const baselineLevel = readU64LE(buf, offset);
  offset += 8;
  const baselineTs = readI64LE(buf, offset);
  offset += 8;
  const cohortSize = buf.readUInt16LE(offset);
  offset += 2;
  const lastLevel = readU64LE(buf, offset);
  offset += 8;
  const lastHourStart = readI64LE(buf, offset);
  offset += 8;
  const componentsHash = buf.subarray(offset, offset + 32).toString("hex");
  offset += 32;
  const lastUpdateSlot = readU64LE(buf, offset);
  offset += 8;
  const bump = buf.readUInt8(offset);

  const level = unscale(Number(lastLevel));
  const baseline = unscale(Number(baselineLevel));
  const change = baseline === 0 ? 0 : ((level - baseline) / baseline) * 100;

  console.log();
  console.log("  " + c.dim("─".repeat(60)));
  console.log("  " + c.mint("DECODED  ") + c.dim("BioHash Peptide Index"));
  console.log();
  console.log("  " + c.mint("authority           ") + c.amber(trim(authority)));
  console.log(
    "  " +
      c.mint("last_index_level    ") +
      c.amber(Number(lastLevel).toLocaleString("en-US")) +
      c.body(`  → ${fmtLevel(level)}  `) +
      (change < 0 ? c.red(`${glyph.arrowDown} ${fmtPct(change)}`) : c.live(`${glyph.arrowUp} ${fmtPct(change)}`)),
  );
  console.log(
    "  " +
      c.mint("baseline_level      ") +
      c.amber(Number(baselineLevel).toLocaleString("en-US")) +
      c.body(`  → ${fmtLevel(baseline)}`),
  );
  console.log(
    "  " +
      c.mint("baseline_timestamp  ") +
      c.amber(Number(baselineTs).toLocaleString("en-US")) +
      c.body(`  → ${fmtUnixDate(Number(baselineTs))}`),
  );
  console.log(
    "  " +
      c.mint("last_hour_start     ") +
      c.amber(Number(lastHourStart).toLocaleString("en-US")) +
      c.body(`  → ${fmtUnixHour(Number(lastHourStart))}`),
  );
  console.log("  " + c.mint("cohort_size         ") + c.amber(String(cohortSize)));
  console.log(
    "  " +
      c.mint("components_hash     ") +
      c.amber(componentsHash.slice(0, 8) + "…" + componentsHash.slice(-8)),
  );
  console.log(
    "  " +
      c.mint("last_update_slot    ") +
      c.amber(Number(lastUpdateSlot).toLocaleString("en-US")),
  );
  console.log("  " + c.mint("bump                ") + c.amber(String(bump)));
}

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

function trim(addr: string): string {
  return addr.slice(0, 8) + "…" + addr.slice(-7);
}

function fmtUnixDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtUnixHour(ts: number): string {
  const d = new Date(ts * 1000).toISOString();
  return d.slice(0, 10) + " " + d.slice(11, 16) + " UTC";
}
