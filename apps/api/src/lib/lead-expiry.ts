import type { SupabaseClient } from "@supabase/supabase-js";
import { logAnomaly } from "@peptide-oracle/shared";

import { sendEmail } from "./email";

/**
 * Lead expiry sweeper. Three timeouts per spec:
 *
 *   1. status='submitted'         > 14 days → auto-reject
 *      (review timeout)
 *   2. status='accepted_pipeline' > 60 days w/o vendor_responded →
 *      mark expired, notify submitter
 *   3. status='vendor_responded'  > 30 days w/o progress →
 *      mark expired, notify submitter
 *
 * Pure-ish: takes a `now` clock for testability, returns a summary of
 * what changed. Side-effects (email, anomaly log) fire from inside.
 *
 * Called from a setInterval at api-app startup (every 6h, with jitter
 * provided by Railway's deploy schedule). Idempotent: re-running on
 * the same data is a no-op because the WHERE clauses gate on the
 * status value, which we just changed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const SUBMITTED_TIMEOUT_DAYS = 14;
export const ACCEPTED_TIMEOUT_DAYS = 60;
export const RESPONDED_TIMEOUT_DAYS = 30;

export interface LeadExpirySummary {
  rejected_review_timeout: number;
  expired_accepted: number;
  expired_responded: number;
}

interface ExpirableLead {
  id: number;
  submitter_id: number;
  vendor_name: string;
}

interface SubmitterEmailRow {
  id: number;
  wallet_address: string;
}

export async function runLeadExpiryJob(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<LeadExpirySummary> {
  const submittedCutoff = new Date(now.getTime() - SUBMITTED_TIMEOUT_DAYS * DAY_MS);
  const acceptedCutoff = new Date(now.getTime() - ACCEPTED_TIMEOUT_DAYS * DAY_MS);
  const respondedCutoff = new Date(now.getTime() - RESPONDED_TIMEOUT_DAYS * DAY_MS);

  // 1. submitted > 14d → rejected (review timeout)
  const submittedExpired = await fetchExpirableLeads(
    supabase,
    "submitted",
    "submitted_at",
    submittedCutoff,
  );
  for (const lead of submittedExpired) {
    await supabase
      .from("vendor_leads")
      .update({
        status: "rejected",
        rejection_reason: `auto-rejected: review timeout (${SUBMITTED_TIMEOUT_DAYS}d)`,
        reviewed_at: now.toISOString(),
      })
      .eq("id", lead.id);
    await notifyExpired(supabase, lead, "review_timeout");
  }

  // 2. accepted_pipeline > 60d → expired
  const acceptedExpired = await fetchExpirableLeads(
    supabase,
    "accepted_pipeline",
    "accepted_at",
    acceptedCutoff,
  );
  for (const lead of acceptedExpired) {
    await supabase
      .from("vendor_leads")
      .update({
        status: "expired",
        expired_at: now.toISOString(),
      })
      .eq("id", lead.id);
    await notifyExpired(supabase, lead, "no_vendor_response");
  }

  // 3. vendor_responded > 30d → expired
  const respondedExpired = await fetchExpirableLeads(
    supabase,
    "vendor_responded",
    "accepted_at", // converted_at would be wrong (set on Tier 3); accepted_at is the last positive timestamp
    respondedCutoff,
  );
  for (const lead of respondedExpired) {
    await supabase
      .from("vendor_leads")
      .update({
        status: "expired",
        expired_at: now.toISOString(),
      })
      .eq("id", lead.id);
    await notifyExpired(supabase, lead, "stalled_after_response");
  }

  const summary: LeadExpirySummary = {
    rejected_review_timeout: submittedExpired.length,
    expired_accepted: acceptedExpired.length,
    expired_responded: respondedExpired.length,
  };
  if (
    summary.rejected_review_timeout +
      summary.expired_accepted +
      summary.expired_responded >
    0
  ) {
    void logAnomaly({
      severity: "info",
      eventType: "lead_expired",
      description: `lead-expiry sweep: ${summary.rejected_review_timeout} review-timeout, ${summary.expired_accepted} accepted-stalled, ${summary.expired_responded} responded-stalled`,
      context: { ...summary, ran_at: now.toISOString() },
    });
  }
  return summary;
}

async function fetchExpirableLeads(
  supabase: SupabaseClient,
  status: string,
  sinceColumn: string,
  cutoff: Date,
): Promise<ExpirableLead[]> {
  const { data, error } = await supabase
    .from("vendor_leads")
    .select("id, submitter_id, vendor_name")
    .eq("status", status)
    .lte(sinceColumn, cutoff.toISOString());
  if (error) {
    void logAnomaly({
      severity: "error",
      eventType: "lead_expired",
      description: `lead-expiry fetch failed for status=${status}: ${error.message}`,
      context: { status, since_column: sinceColumn, cutoff: cutoff.toISOString() },
    });
    return [];
  }
  return (data ?? []) as ExpirableLead[];
}

async function notifyExpired(
  supabase: SupabaseClient,
  lead: ExpirableLead,
  reason: "review_timeout" | "no_vendor_response" | "stalled_after_response",
): Promise<void> {
  const { data: submitter } = await supabase
    .from("submitters")
    .select("id, wallet_address")
    .eq("id", lead.submitter_id)
    .single<SubmitterEmailRow>();
  if (!submitter) return;
  await sendEmail({
    to: `wallet:${submitter.wallet_address}`,
    template: "lead_expired",
    data: {
      lead_id: lead.id,
      vendor_name: lead.vendor_name,
      reason,
    },
  });
}

/**
 * Wire to the api app's main loop. Runs once at startup (with a
 * 30s delay to let the rest of boot settle), then every 6h. Tied
 * to an AbortSignal so SIGTERM cleanly stops the timer.
 */
export function startLeadExpiryLoop(opts: {
  supabase: SupabaseClient;
  intervalMs?: number;
  startupDelayMs?: number;
  signal: AbortSignal;
}): void {
  const interval = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  const startupDelay = opts.startupDelayMs ?? 30_000;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (opts.signal.aborted) return;
    try {
      const summary = await runLeadExpiryJob(opts.supabase);
      console.log(
        `[lead-expiry] reject_timeout=${summary.rejected_review_timeout} ` +
          `expired_accepted=${summary.expired_accepted} ` +
          `expired_responded=${summary.expired_responded}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error(`[lead-expiry] sweep threw: ${msg}`);
    }
  };

  const startupTimer = setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), interval);
  }, startupDelay);

  opts.signal.addEventListener("abort", () => {
    clearTimeout(startupTimer);
    if (timer) clearInterval(timer);
  });
}
