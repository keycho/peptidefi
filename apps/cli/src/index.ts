#!/usr/bin/env node
import { Command } from "commander";
import { renderSplash } from "./lib/splash.js";
import { VERSION } from "./lib/theme.js";
import { indexCommand } from "./commands/index.js";
import { peptideCommand } from "./commands/peptide.js";
import { peptidesCommand } from "./commands/peptides.js";
import { verifyCommand } from "./commands/verify.js";
import { accountCommand } from "./commands/account.js";

const program = new Command();

program
  .name("biohash")
  .description("On-chain peptide price discovery, from your terminal.")
  .version(VERSION, "-v, --version", "show version")
  .helpOption("-h, --help", "show help");

// `biohash index [--history 7d]`
program
  .command("index")
  .description("show the current BioHash Peptide Index level")
  .option("--history <range>", "show last N hours/days (e.g. 24h, 7d)")
  .action(indexCommand);

// `biohash peptide <code> [--vendors]`
program
  .command("peptide <code>")
  .description("show current TWAP price for a peptide (e.g. BPC157)")
  .option("--vendors", "show per-vendor breakdown with bps from median")
  .action(peptideCommand);

// `biohash peptides`
program
  .command("peptides")
  .description("show all tracked peptides with current prices and observation status")
  .option("--instant", "render the full table without the staggered reveal animation")
  .action(peptidesCommand);

// `biohash verify --cycle <n>`
program
  .command("verify")
  .description("verify a TWAP cycle against Solana mainnet and IPFS")
  .requiredOption("--cycle <id>", "cycle id to verify")
  .action(verifyCommand);

// `biohash account <pubkey> [--cluster devnet]`
program
  .command("account <pubkey>")
  .description("inspect any Solana account; decodes the BioHash index PDA natively")
  .option("--cluster <name>", "mainnet-beta or devnet", "mainnet-beta")
  .action(accountCommand);

// No args -> splash
if (process.argv.length <= 2) {
  console.log(renderSplash());
  process.exit(0);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
