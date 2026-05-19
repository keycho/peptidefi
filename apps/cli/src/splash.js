// BIOHASH splash: ASCII logo, info panel, status line, version stamp.
// Mainnet-focused — no devnet references.

import { c } from './theme.js';
import { MAINNET_STATS } from './mock.js';

const BIOHASH_LINES = [
  '██████   ██  ██████   ██   ██   █████   ███████  ██   ██',
  '██   ██  ██  ██   ██  ██   ██  ██   ██  ██       ██   ██',
  '██████   ██  ██   ██  ███████  ███████  ███████  ███████',
  '██   ██  ██  ██   ██  ██   ██  ██   ██       ██  ██   ██',
  '██████   ██  ██████   ██   ██  ██   ██  ███████  ██   ██',
];

const SUBTITLE = '+ on-chain peptide price discovery +';

function panel(rows) {
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const valueWidth = Math.max(...rows.map(([, v]) => v.length));
  const inner = labelWidth + 4 + valueWidth + 2;
  const top = '┌' + '─'.repeat(inner) + '┐';
  const bot = '└' + '─'.repeat(inner) + '┘';
  const body = rows.map(([l, v]) => {
    const label = c.label(l.padEnd(labelWidth));
    const val = c.cream(v.padEnd(valueWidth));
    return `│ ${label}    ${val} │`;
  });
  return [top, ...body, bot];
}

export function renderSplash() {
  const out = [];
  const s = MAINNET_STATS;

  out.push('');
  BIOHASH_LINES.forEach(line => out.push('  ' + c.logo(line)));
  out.push('');
  out.push('  ' + c.cream(SUBTITLE));
  out.push('');

  panel([
    ['Network',  'Solana mainnet-beta'],
    ['Endpoint', 'https://api.biohash.network'],
    ['Status',   `live · cycle ${s.cycle.toLocaleString()}`],
    ['Slot',     s.current_slot.toLocaleString()],
  ]).forEach(line => out.push('  ' + line));

  out.push('');

  out.push(
    `  ${c.live('●')} ${c.amber(s.twap_commits.toLocaleString() + '+')} ${c.cream('TWAP commits')}` +
    `   ${c.dim('·')}   ${c.amber(String(s.cohort_size))} ${c.cream('peptides')}` +
    `   ${c.dim('·')}   ${c.amber(String(s.vendor_count))} ${c.cream('vendors')}` +
    `   ${c.dim('·')}   ${c.cream('every ~' + s.hourly_cadence_min + ' min')}`
  );
  out.push('');

  out.push('  ' + c.dim('biohash ') + c.cream('v0.1.0') + '   ' + c.dim('·   type ') + c.cream('biohash help') + c.dim(' for commands'));
  out.push('');

  return out.join('\n');
}

export function renderHeader() {
  const out = [];
  out.push('');
  BIOHASH_LINES.forEach(line => out.push('  ' + c.logo(line)));
  out.push('');
  out.push('  ' + c.cream(SUBTITLE) + '   ' + c.dim('·') + '   ' + c.dim('biohash ') + c.cream('v0.1.0'));
  out.push('');
  out.push('  ' + c.dim('─'.repeat(72)));
  return out.join('\n');
}
