#!/usr/bin/env node
// BioHash CLI v0.1.0

import { Command } from 'commander';
import { renderSplash } from './splash.js';
import {
  cmdIndex,
  cmdPeptide,
  cmdPeptides,
  cmdWatch,
  cmdCohort,
  cmdVerify,
  cmdAccount,
} from './commands.js';
import { c } from './theme.js';

const program = new Command();

program
  .name('biohash')
  .description('on-chain peptide price discovery')
  .version('0.1.0')
  .helpOption(false)
  .action(() => {
    process.stdout.write(renderSplash());
  });

program
  .command('index')
  .description('current peptide index level')
  .option('--history', 'show last 7 days of index history')
  .action(cmdIndex);

program
  .command('peptide <code>')
  .description('current price for a peptide')
  .option('--vendors', 'per-vendor pricing breakdown')
  .action(cmdPeptide);

program
  .command('peptides')
  .description('show all tracked peptides with current prices and observation status')
  .action(() => cmdPeptides());

program
  .command('watch')
  .description('live observation stream from the oracle')
  .action(cmdWatch);

program
  .command('cohort')
  .description('cohort composition · top movers · price distribution')
  .action(cmdCohort);

program
  .command('verify')
  .description('verify a cycle commit on Solana mainnet')
  .option('--cycle <n>', 'cycle id to verify', v => parseInt(v, 10))
  .action(cmdVerify);

program
  .command('account [pubkey]')
  .description('decode a BioHash on-chain account')
  .action(cmdAccount);

program
  .command('help')
  .description('show command list')
  .action(() => {
    console.log('');
    console.log('  ' + c.muted('COMMANDS'));
    console.log('');
    console.log('  ' + c.cream('biohash index') + '              ' + c.dim('current index level'));
    console.log('  ' + c.cream('biohash index --history') + '    ' + c.dim('last 7 days'));
    console.log('  ' + c.cream('biohash peptide <code>') + '     ' + c.dim('current price for a peptide'));
    console.log('  ' + c.cream('biohash peptide <code>') + '     ' + c.dim('  --vendors  per-vendor breakdown'));
    console.log('  ' + c.cream('biohash peptides') + '           ' + c.dim('full market view, all tracked peptides'));
    console.log('  ' + c.cream('biohash watch') + '              ' + c.dim('live observation stream'));
    console.log('  ' + c.cream('biohash cohort') + '             ' + c.dim('cohort composition + movers'));
    console.log('  ' + c.cream('biohash verify --cycle <n>') + ' ' + c.dim('verify a cycle commit'));
    console.log('  ' + c.cream('biohash account [pubkey]') + '   ' + c.dim('decode an on-chain account'));
    console.log('');
    console.log('  ' + c.dim('docs: ') + c.mint('biohash.network'));
    console.log('');
  });

program.parse();
