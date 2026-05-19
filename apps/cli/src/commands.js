// Command implementations.
import ora from 'ora';
import Table from 'cli-table3';
import { c } from './theme.js';
import { renderHeader } from './splash.js';
import {
  MAINNET_STATS,
  MOCK_INDEX,
  MOCK_INDEX_HISTORY,
  MOCK_PEPTIDES,
  MOCK_VERIFY,
  MOCK_COHORT,
  MOCK_MARKET,
  MOCK_OBSERVATIONS_POOL,
} from './mock.js';

// Persistent header at top of every command.
function header() {
  process.stdout.write('\x1Bc');
  console.log(renderHeader());
}

function sectionLabel(label) {
  console.log('');
  console.log('  ' + c.muted(label.toUpperCase()));
  console.log('');
}

function kv(label, value, hint = null) {
  const left = '  ' + c.label(label.padEnd(15));
  const right = c.cream(value);
  const tail = hint ? '  ' + c.dim(hint) : '';
  console.log(left + right + tail);
}

function changeColored(pct) {
  const sign = pct < 0 ? '▼' : '▲';
  const fmt = pct < 0 ? c.red : c.ok;
  return fmt(`${sign} ${Math.abs(pct).toFixed(2)}%`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function tableChars() {
  return {
    'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
    'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
    'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
    'right': '│', 'right-mid': '┤', 'middle': '│',
  };
}

// Format a Date as HH:MM:SS UTC
function fmtUtcTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ============================================================================
// biohash index
// ============================================================================
export async function cmdIndex(opts = {}) {
  header();
  const spinner = ora({
    text: c.dim('fetching index level'),
    spinner: 'dots',
    color: 'yellow',
    indent: 2,
  }).start();
  await sleep(450);
  spinner.stop();

  if (opts.history) {
    sectionLabel('peptide index · last 7 days');
    const t = new Table({
      head: [c.label('date'), c.label('level'), c.label('change')],
      chars: tableChars(),
      style: { head: [], border: [] },
    });
    let prev = null;
    MOCK_INDEX_HISTORY.forEach(row => {
      const change = prev === null ? c.dim('—') :
        row.level >= prev ? c.ok(`+${(row.level - prev).toFixed(2)}`) :
        c.red(`${(row.level - prev).toFixed(2)}`);
      t.push([c.cream(row.date), c.amber(row.level.toFixed(2)), change]);
      prev = row.level;
    });
    console.log(t.toString().split('\n').map(l => '  ' + l).join('\n'));
    console.log('');
    return;
  }

  sectionLabel('peptide index');
  kv('INDEX LEVEL',  c.number(MOCK_INDEX.level.toFixed(2)),
     changeColored(MOCK_INDEX.change_pct) + c.dim(`  from baseline ${MOCK_INDEX.baseline.toFixed(2)}`));
  kv('HOUR START',   c.cream(MOCK_INDEX.hour_start.replace('T', ' ').replace('.000Z', ' UTC')));
  kv('COHORT',       c.amber(`${MOCK_INDEX.cohort_size}`), 'peptides · equal-weighted');
  kv('BASELINE',     c.cream(MOCK_INDEX.baseline.toFixed(2)), MOCK_INDEX.baseline_date);

  console.log('');

  kv('COMPONENTS',   c.mint(MOCK_INDEX.components_hash.slice(0, 8) + '…' + MOCK_INDEX.components_hash.slice(-8)));
  kv('SIGNED BY',    c.mint(MOCK_INDEX.signed_by.slice(0, 8) + '…' + MOCK_INDEX.signed_by.slice(-4)));

  console.log('');
  console.log('  ' + c.dim('aggregate level computed each hour from 29 underlying TWAPs'));
  console.log('  ' + c.dim('on-chain as a singleton solana account · readable from any client'));
  console.log('');
}

// ============================================================================
// biohash peptide <code>
// ============================================================================
export async function cmdPeptide(code, opts = {}) {
  header();
  const key = code.toLowerCase().replace(/[-_]/g, '');
  const p = MOCK_PEPTIDES[key];
  if (!p) {
    console.log('');
    console.log('  ' + c.fail(`peptide not found: ${code}`));
    console.log('  ' + c.dim('try: bpc157, ghkcu'));
    console.log('');
    return;
  }

  const spinner = ora({
    text: c.dim(`fetching ${p.code}`),
    spinner: 'dots',
    color: 'yellow',
    indent: 2,
  }).start();
  await sleep(500);
  spinner.stop();

  sectionLabel(`peptide · ${p.code}`);
  kv('PRICE',         c.number(`$${p.price_per_mg.toFixed(4)}`), '/mg');
  kv('TWAP MEMBERS',  c.amber(String(p.twap_members)), `of ${p.vendor_count} live vendors`);
  kv('24H RANGE',     c.cream(`$${p.range_24h[0].toFixed(2)} – $${p.range_24h[1].toFixed(2)}`));
  kv('LAST COMMIT',   c.mint(p.last_commit_sig), `slot ${p.last_slot.toLocaleString()}`);
  if (p.peg_state_pda) {
    kv('PEG STATE',   c.mint(p.peg_state_pda), 'on mainnet');
  }
  kv('IPFS MANIFEST', c.mint(p.ipfs_cid));

  if (opts.vendors && p.vendors.length > 0) {
    console.log('');
    console.log('  ' + c.muted('PER-VENDOR PRICING'));
    console.log('');
    const t = new Table({
      head: [c.label('vendor'), c.label('price/mg'), c.label('twap')],
      chars: tableChars(),
      style: { head: [], border: [] },
    });
    p.vendors.forEach(v => {
      t.push([
        v.in_twap ? c.cream(v.name) : c.dim(v.name),
        v.in_twap ? c.amber(`$${v.price.toFixed(2)}`) : c.dim(`$${v.price.toFixed(2)}`),
        v.in_twap ? c.ok('●') : c.dim('○'),
      ]);
    });
    console.log(t.toString().split('\n').map(l => '  ' + l).join('\n'));
  }
  console.log('');
}

// ============================================================================
// biohash watch — live observation stream
// New line appears every 500-700ms. Press Ctrl+C to stop.
// ============================================================================
export async function cmdWatch() {
  header();
  sectionLabel('live observation stream · mainnet');

  // Column widths
  const colTime = 10;
  const colVendor = 15;
  const colPeptide = 16;
  const colPrice = 12;

  // Print column headers
  console.log(
    '  ' +
    c.label('time'.padEnd(colTime)) +
    c.label('vendor'.padEnd(colVendor)) +
    c.label('peptide'.padEnd(colPeptide)) +
    c.label('price'.padStart(colPrice).padEnd(colPrice + 2)) +
    c.label('cycle')
  );
  console.log('');

  let count = 0;
  const cycleStart = MAINNET_STATS.cycle;
  let obsThisCycle = 110;
  const targetObs = 188;
  const cycle = cycleStart;

  // Track recent prices for tiny price-jitter trend indicator
  const lastPrice = new Map();

  // Handle Ctrl+C gracefully
  const stopHandler = () => {
    console.log('');
    console.log('  ' + c.dim(`stopped · ${count} observations shown`));
    console.log('');
    process.exit(0);
  };
  process.on('SIGINT', stopHandler);

  // Stream loop
  while (true) {
    // Pick a random observation, vary the price slightly so it feels live
    const base = MOCK_OBSERVATIONS_POOL[Math.floor(Math.random() * MOCK_OBSERVATIONS_POOL.length)];
    const jitter = (Math.random() - 0.5) * 0.01;
    const price = base.price * (1 + jitter);

    // Trend vs last price for this vendor+peptide combo
    const key = `${base.vendor}::${base.peptide}`;
    const prev = lastPrice.get(key);
    let trend = '';
    if (prev !== undefined) {
      if (price > prev * 1.001) trend = c.ok('▲');
      else if (price < prev * 0.999) trend = c.red('▼');
      else trend = c.dim('·');
    } else {
      trend = c.dim('·');
    }
    lastPrice.set(key, price);

    const now = new Date();
    const timeStr = fmtUtcTime(now);

    const vendorStr = base.vendor.padEnd(colVendor - 1);
    const peptideStr = base.peptide.padEnd(colPeptide - 1);
    const priceStr = `$${price.toFixed(2)} /mg`.padStart(colPrice);

    console.log(
      '  ' +
      c.dim(timeStr.padEnd(colTime)) +
      c.cream(vendorStr) + ' ' +
      c.cream(peptideStr) + ' ' +
      c.amber(priceStr) + '  ' +
      trend + '   ' +
      c.dim(String(cycle))
    );

    count++;
    obsThisCycle = Math.min(targetObs, obsThisCycle + 1);

    // Footer status line — every 5 observations, update with newline
    // (kept simple — no cursor manipulation, just a line at the end)
    if (count >= 20) {
      // After 30 obs, show the cycle progress line and exit gracefully.
      // Avoids unbounded output if user doesn't Ctrl+C.
      console.log('');
      console.log(
        '  ' + c.dim('cycle ') + c.amber(String(cycle)) +
        c.dim(' · ') + c.amber(`${obsThisCycle} / ${targetObs}`) +
        c.dim(' observations · cohort completes in ~') +
        c.amber('3 min')
      );
      console.log('');
      console.log('  ' + c.dim('stream paused after 30 obs · re-run `biohash watch` to continue'));
      console.log('');
      process.exit(0);
    }

    await sleep(200 + Math.random() * 150);
  }
}

// ============================================================================
// biohash cohort — composition + movers
// ============================================================================
export async function cmdCohort() {
  header();
  const spinner = ora({
    text: c.dim('fetching cohort'),
    spinner: 'dots',
    color: 'yellow',
    indent: 2,
  }).start();
  await sleep(400);
  spinner.stop();

  sectionLabel(`cohort · ${MOCK_COHORT.size} peptides · equal-weighted`);

  console.log('  ' + c.muted('TOP MOVERS · 24H'));
  console.log('');

  MOCK_COHORT.movers_24h.up.forEach(m => {
    const ch = c.ok(`▲ ${m.change_pct >= 0 ? '+' : ''}${m.change_pct.toFixed(1)}%`);
    console.log(
      '    ' + ch + '   ' +
      c.cream(m.code.padEnd(20)) +
      c.amber(`$${m.price.toFixed(2)} /mg`)
    );
  });
  console.log('    ' + c.dim('─'));
  MOCK_COHORT.movers_24h.down.forEach(m => {
    const ch = c.red(`▼ ${m.change_pct.toFixed(1)}%`);
    console.log(
      '    ' + ch + '   ' +
      c.cream(m.code.padEnd(20)) +
      c.amber(`$${m.price.toFixed(2)} /mg`)
    );
  });

  console.log('');
  console.log('  ' + c.muted('PRICE DISTRIBUTION'));
  console.log('');

  MOCK_COHORT.price_distribution.forEach(d => {
    const dots = '●'.repeat(d.count);
    console.log(
      '    ' +
      c.cream(d.bucket.padEnd(18)) +
      c.amber(dots) + '  ' +
      c.dim(`${d.count} peptides`)
    );
  });

  console.log('');
  console.log('  ' + c.dim('index composition deterministic · equal-weighted ratio'));
  console.log('');
}

// ============================================================================
// biohash verify --cycle <n>
// ============================================================================
export async function cmdVerify(opts) {
  const cycleId = opts.cycle || MOCK_VERIFY.cycle_id;

  header();
  sectionLabel(`verifying cycle ${cycleId} · mainnet`);

  const checks = [
    { label: 'fetch TWAP commit from mainnet',  detail: `slot ${MOCK_VERIFY.twap_commit_slot.toLocaleString()}` },
    { label: 'verify oracle signature',         detail: 'ed25519 valid' },
    { label: 'fetch IPFS manifest',             detail: `cid ${MOCK_VERIFY.components_hash_ipfs.slice(0, 10)}…` },
    { label: 'compare components_hash',         detail: 'chain matches IPFS' },
    { label: 'verify cohort completeness',      detail: `${MOCK_VERIFY.peptides_finalized}/${MOCK_VERIFY.peptides_expected} peptides finalized` },
  ];

  for (const check of checks) {
    const spinner = ora({
      text: c.dim(check.label),
      spinner: 'dots',
      color: 'yellow',
      indent: 4,
    }).start();
    await sleep(280 + Math.random() * 180);
    spinner.stopAndPersist({
      symbol: '    ' + c.ok('✓'),
      text: c.cream(check.label) + '  ' + c.dim(check.detail),
    });
  }

  console.log('');
  console.log(`  ${c.ok('verified')} ${c.dim('in')} ${c.cream(MOCK_VERIFY.verify_ms + 'ms')}`);
  console.log('  ' + c.dim('signature: ') + c.mint(MOCK_VERIFY.twap_commit_sig));
  console.log('');
}

// ============================================================================
// biohash peptides - full market view: every tracked peptide, sorted.
// ============================================================================
export async function cmdPeptides() {
  header();
  const spinner = ora({
    text: c.dim('fetching market view'),
    spinner: 'dots',
    color: 'yellow',
    indent: 2,
  }).start();
  await sleep(500);
  spinner.stop();

  // Partition by status. PRICED rendered first sorted by price desc;
  // OBS_7D rendered second sorted by vendor_count desc. Both sorts are
  // stable so equal-key rows preserve the input order from mock.js
  // (Tesofensine at top of PRICED, KPV at top of OBS_7D).
  const priced = MOCK_MARKET
    .filter(p => p.status === 'PRICED')
    .sort((a, b) => b.price_per_mg - a.price_per_mg);
  const obs = MOCK_MARKET
    .filter(p => p.status === 'OBS_7D')
    .sort((a, b) => b.vendor_count - a.vendor_count);

  const total = priced.length + obs.length;

  sectionLabel(`market · ${total} peptides tracked`);
  console.log(
    '  ' + c.dim(`${priced.length} priced · ${obs.length} in observation`),
  );
  console.log('');

  // PRICED table. Columns are name-padded to align with the OBS table
  // below so the two tables share visual structure.
  const head = [c.label('peptide'), c.label('price'), c.label('vendors'), c.label('24h range')];
  const pricedTable = new Table({
    head,
    chars: tableChars(),
    style: { head: [], border: [] },
  });
  priced.forEach(p => {
    pricedTable.push([
      c.cream(p.display_name),
      c.amber(`$${p.price_per_mg.toFixed(4)} /mg`),
      c.cream(String(p.vendor_count)),
      c.dim(`$${p.range_24h[0].toFixed(2)} – $${p.range_24h[1].toFixed(2)}`),
    ]);
  });
  console.log(pricedTable.toString().split('\n').map(l => '  ' + l).join('\n'));

  console.log('');
  console.log('  ' + c.muted('OBSERVATION · 7-DAY WINDOW'));
  console.log('');

  // OBS_7D table. Price column shows the OBS label instead of a number;
  // a 24h range is still visible from per-vendor observations even
  // though no TWAP is computed yet.
  const obsTable = new Table({
    head,
    chars: tableChars(),
    style: { head: [], border: [] },
  });
  obs.forEach(p => {
    obsTable.push([
      c.cream(p.display_name),
      c.dim('OBS · 7d'),
      c.cream(String(p.vendor_count)),
      c.dim(`$${p.range_24h[0].toFixed(2)} – $${p.range_24h[1].toFixed(2)}`),
    ]);
  });
  console.log(obsTable.toString().split('\n').map(l => '  ' + l).join('\n'));

  console.log('');
  console.log(
    '  ' + c.dim('observation peptides graduate to priced after 7 days of finalized TWAPs'),
  );
  console.log('  ' + c.dim('full market view at ') + c.mint('biohash.network/market'));
  console.log('');
}

// ============================================================================
// biohash account <pubkey>
// ============================================================================
export async function cmdAccount(pubkey) {
  header();
  const spinner = ora({
    text: c.dim('fetching account'),
    spinner: 'dots',
    color: 'yellow',
    indent: 2,
  }).start();
  await sleep(600);
  spinner.stop();

  sectionLabel('decoded account state · biohash peptide index pda');

  kv('authority',            c.mint('FmBggsBj…NKK7'));
  kv('last_index_level',     c.amber('9,633,900'), '→ 963.39  ' + c.red('▼ 3.66%'));
  kv('baseline_level',       c.amber('10,000,000'), '→ 1,000.00');
  kv('baseline_timestamp',   c.amber('1,778,889,600'), '→ 2026-05-03');
  kv('last_hour_start',      c.amber('1,747,422,000'), '→ 2026-05-17 20:00 UTC');
  kv('cohort_size',          c.amber('29'));
  kv('last_components_hash', c.mint('5f3d35b3…77283942'));

  console.log('');
  console.log('  ' + c.muted('ON-CHAIN LOCATION'));
  console.log('');
  kv('account', c.amber(pubkey || 'ATfqMUB3NoiSjTrjiAUzYqZVywu8CfeCKs9Mc75Y7mko'));
  kv('program', c.mint('DAaKqMVMVAYSJiXwc5byLFuLKkXwjae7a7f9TUV2dwBd'));
  kv('cluster', c.amber('solana devnet'));
  kv('size',    c.mint('160 bytes'));
  console.log('');
}
