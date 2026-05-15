/**
 * One-shot script to compute and persist the per-peptide baseline TWAP
 * snapshots used by the BioHash Peptide Index (migration 0043).
 *
 * For each active peptide:
 *   - Look up the earliest finalized twap_commits row with
 *     computed_at >= 2026-03-01 00:00:00 UTC.
 *   - If that row's computed_at falls on 2026-03-01, the peptide was
 *     active at the configured baseline date: actual_baseline_date
 *     equals baseline_date.
 *   - Otherwise the peptide started observation after the baseline
 *     date: actual_baseline_date is the row's computed_at::date.
 *   - If no finalized row exists at-or-after the baseline date, the
 *     peptide is reported as MISSING and not written.
 *
 * Writes one row per peptide to public.index_baselines. Idempotent
 * via ON CONFLICT (peptide_code) DO NOTHING -- re-running this script
 * after a successful apply is a no-op. The table is intentionally
 * read-only after launch (the oracle never rewrites baselines), so
 * if you need to refresh a row you must DELETE it first.
 *
 * Usage:
 *   pnpm tsx apps/oracle/scripts/compute-baseline-twaps.ts
 *     -- dry-run, prints the summary table, writes nothing
 *
 *   pnpm tsx apps/oracle/scripts/compute-baseline-twaps.ts --apply
 *     -- prints the summary table AND writes rows to index_baselines
 *
 * Env:
 *   ORACLE_DATABASE_URL  -- postgres:// session-mode URL, same one the
 *                           oracle service uses (see apps/oracle/.env.example).
 *
 * Output:
 *   Fixed-width summary table to stdout. Stderr is used only for
 *   warnings (MISSING peptides). Exit code is 0 unless a hard error
 *   occurs (DB unreachable, etc.) or --apply was requested and the
 *   table is non-empty AND any peptide differs from the existing row
 *   (the script refuses to silently overwrite -- delete first).
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import postgres from 'postgres';

const BASELINE_DATE = '2026-03-01';
const BASELINE_TS = '2026-03-01 00:00:00+00';
const BASELINE_LEVEL = 1000;

interface CliOpts {
  apply: boolean;
}

function parseCli(): CliOpts {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return { apply: !!values.apply };
}

interface ActivePeptide {
  peptide_code: string;
}

interface BaselineRow {
  peptide_code: string;
  baseline_twap: string | null;
  actual_baseline_date: string | null;
}

async function main(): Promise<void> {
  const opts = parseCli();
  const url = process.env.ORACLE_DATABASE_URL;
  if (!url || url.length === 0) {
    console.error('ORACLE_DATABASE_URL is required');
    process.exit(2);
  }

  const sql = postgres(url, { max: 2, idle_timeout: 10 });
  try {
    const peptides = await sql<ActivePeptide[]>`
      SELECT code AS peptide_code
      FROM   public.peptides
      WHERE  is_active = true
      ORDER BY code ASC
    `;

    if (peptides.length === 0) {
      console.error('no active peptides found, refusing to proceed');
      process.exit(2);
    }

    const rows: BaselineRow[] = [];
    for (const p of peptides) {
      const res = await sql<
        { twap_value: string; computed_at: Date }[]
      >`
        SELECT twap_value, computed_at
        FROM   public.twap_commits
        WHERE  peptide_code = ${p.peptide_code}
          AND  status       = 'finalized'
          AND  computed_at >= ${BASELINE_TS}::timestamptz
        ORDER BY computed_at ASC
        LIMIT 1
      `;
      if (res.length === 0) {
        rows.push({
          peptide_code: p.peptide_code,
          baseline_twap: null,
          actual_baseline_date: null,
        });
        continue;
      }
      const row = res[0]!;
      rows.push({
        peptide_code: p.peptide_code,
        baseline_twap: row.twap_value,
        actual_baseline_date: toYmd(row.computed_at),
      });
    }

    printSummary(rows);

    const missing = rows.filter((r) => r.baseline_twap === null);
    if (missing.length > 0) {
      console.error(
        `${missing.length} peptide(s) have no finalized TWAP at-or-after ${BASELINE_DATE}: ` +
          missing.map((r) => r.peptide_code).join(', '),
      );
    }

    if (!opts.apply) {
      console.log('');
      console.log('DRY-RUN: no rows written. Re-run with --apply to persist.');
      return;
    }

    if (missing.length > 0) {
      console.error('refusing to --apply while peptides are missing baselines');
      process.exit(3);
    }

    const existing = await sql<{ peptide_code: string }[]>`
      SELECT peptide_code FROM public.index_baselines
    `;
    if (existing.length > 0) {
      console.error(
        `index_baselines already has ${existing.length} row(s). ` +
          `Refusing to overwrite. DELETE the table first if you need to rewrite.`,
      );
      process.exit(4);
    }

    let inserted = 0;
    for (const r of rows) {
      const result = await sql`
        INSERT INTO public.index_baselines
          (peptide_code, baseline_twap, baseline_date, actual_baseline_date)
        VALUES
          (${r.peptide_code},
           ${r.baseline_twap}::numeric,
           ${BASELINE_DATE}::date,
           ${r.actual_baseline_date}::date)
        ON CONFLICT (peptide_code) DO NOTHING
      `;
      if (result.count > 0) inserted += 1;
    }

    console.log('');
    console.log(
      `APPLIED: inserted ${inserted}/${rows.length} rows into index_baselines ` +
        `(baseline_date=${BASELINE_DATE}, baseline_level=${BASELINE_LEVEL}).`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function printSummary(rows: BaselineRow[]): void {
  const header = ['peptide_code', 'baseline_twap', 'baseline_date', 'actual_baseline_date', 'days_after_baseline'];
  const data = rows.map((r) => [
    r.peptide_code,
    r.baseline_twap ?? 'MISSING',
    BASELINE_DATE,
    r.actual_baseline_date ?? 'MISSING',
    r.actual_baseline_date ? String(daysBetween(BASELINE_DATE, r.actual_baseline_date)) : 'MISSING',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i]!.length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');

  const onBaseline = rows.filter(
    (r) => r.actual_baseline_date === BASELINE_DATE,
  ).length;
  const fallback = rows.filter(
    (r) =>
      r.actual_baseline_date !== null &&
      r.actual_baseline_date !== BASELINE_DATE,
  ).length;
  const missing = rows.length - onBaseline - fallback;

  console.log(
    `BioHash Peptide Index baselines, baseline_date=${BASELINE_DATE} baseline_level=${BASELINE_LEVEL}`,
  );
  console.log(
    `  ${rows.length} peptides total, ${onBaseline} on baseline date, ${fallback} fell back to later date, ${missing} missing`,
  );
  console.log('');
  console.log(fmt(header));
  console.log(sep);
  for (const row of data) console.log(fmt(row));
}

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.UTC(
    Number(fromYmd.slice(0, 4)),
    Number(fromYmd.slice(5, 7)) - 1,
    Number(fromYmd.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toYmd.slice(0, 4)),
    Number(toYmd.slice(5, 7)) - 1,
    Number(toYmd.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
