import type { SupabaseClient } from "@supabase/supabase-js";
import { logAnomaly } from "@peptide-oracle/shared";

/**
 * Bounty payout amounts + recording.
 *
 * USDC-only. Tier 1 is RECOGNITION (lead acceptance bumps the
 * leaderboard counter and earns Verified Submitter status, but pays
 * nothing). Tier 2 is a flat $25 USDC. Tier 3 varies by partnership
 * tier: $100 / $250 / $500 for Listing / Feed / Reserve.
 *
 * Why no $BIOHASH: token valuation makes the math meaningless
 * ($0.19 at the original Tier 1 amount). Including BIO payouts in
 * announcements reads as dishonest. Reintroduce after V0.2 staking
 * ships and price discovery is utility-driven.
 *
 * MVP is MANUAL: an admin endpoint records the payout (treasury
 * Solana tx is signed out-of-band by the operator). recordPayout()
 * just writes the audit row and bumps submitter totals — no on-
 * chain action.
 *
 * Append-only contract: bounty_payouts has no UPDATE/DELETE policy
 * (migration 0035). recordPayout() inserts only; if the insert
 * fails we log the failure and surface to the caller, but never
 * "fix up" or retry. A failed payout becomes its own anomaly event
 * for the operator to handle manually.
 */

export type PartnershipTier =
  | "verified_listing"
  | "verified_feed"
  | "verified_reserve";

const intParseOr = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Constant table. Env-var overrides BOUNTY_TIER2_USDC,
 * BOUNTY_TIER3_LISTING_USDC, BOUNTY_TIER3_FEED_USDC,
 * BOUNTY_TIER3_RESERVE_USDC let an operator tune without a redeploy.
 *
 * Tier 1 has no entry — it's recognition only, not callable here.
 */
export function bountyUsdcFor(args:
  | { tier: 2 }
  | { tier: 3; partnershipTier: PartnershipTier }
): number {
  if (args.tier === 2) {
    return intParseOr(process.env.BOUNTY_TIER2_USDC, 25);
  }
  switch (args.partnershipTier) {
    case "verified_listing":
      return intParseOr(process.env.BOUNTY_TIER3_LISTING_USDC, 100);
    case "verified_feed":
      return intParseOr(process.env.BOUNTY_TIER3_FEED_USDC, 250);
    case "verified_reserve":
      return intParseOr(process.env.BOUNTY_TIER3_RESERVE_USDC, 500);
  }
}

export interface RecordPayoutArgs {
  supabase: SupabaseClient;
  submitterId: number;
  leadId: number;
  tier: 2 | 3;
  /** Required for tier 3 (varies by partnership tier). Ignored for tier 2. */
  partnershipTier?: PartnershipTier;
  introMultiplier: number;
  payoutTxSignature: string | null;
  paidBy: string;
}

export interface RecordedPayout {
  id: number;
  amountUsdc: number;
}

/**
 * Insert a bounty_payouts row + bump the submitter's USDC total.
 * Throws on DB failure — caller catches and surfaces a 500 to the
 * admin. Tier 1 is intentionally not callable here (the constraint
 * `tier in (2, 3)` would also reject it at the DB).
 */
export async function recordPayout(args: RecordPayoutArgs): Promise<RecordedPayout> {
  const baseUsdc =
    args.tier === 2
      ? bountyUsdcFor({ tier: 2 })
      : bountyUsdcFor({
          tier: 3,
          partnershipTier:
            args.partnershipTier ??
            (() => {
              throw new Error(
                "recordPayout(tier=3) requires partnershipTier",
              );
            })(),
        });
  const amountUsdc = Math.round(baseUsdc * args.introMultiplier);

  const { data: inserted, error: insertErr } = await args.supabase
    .from("bounty_payouts")
    .insert({
      submitter_id: args.submitterId,
      lead_id: args.leadId,
      tier: args.tier,
      amount_usdc: amountUsdc,
      intro_multiplier: args.introMultiplier,
      payout_tx_signature: args.payoutTxSignature,
      paid_by: args.paidBy,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    const msg = insertErr?.message ?? "insert returned no row";
    void logAnomaly({
      severity: "error",
      eventType: "bounty_payout_failed",
      description: `bounty_payouts insert failed for submitter ${args.submitterId} lead ${args.leadId} tier ${args.tier}: ${msg}`,
      context: {
        submitter_id: args.submitterId,
        lead_id: args.leadId,
        tier: args.tier,
        amount_usdc: amountUsdc,
      },
    });
    throw new Error(`recordPayout insert failed: ${msg}`);
  }

  // Bump submitter total. Read-modify-write — race-tolerant because
  // each payout is admin-triggered (single-writer per submitter at
  // a time). The audit row is the source of truth; if the cached
  // total drifts, an operator can rebuild via:
  //   UPDATE submitters SET total_paid_usdc = (SELECT SUM(amount_usdc)
  //     FROM bounty_payouts WHERE submitter_id = submitters.id);
  const { data: cur } = await args.supabase
    .from("submitters")
    .select("total_paid_usdc")
    .eq("id", args.submitterId)
    .single();
  const prevUsdc = Number((cur as { total_paid_usdc: number } | null)?.total_paid_usdc ?? 0);
  await args.supabase
    .from("submitters")
    .update({ total_paid_usdc: prevUsdc + amountUsdc })
    .eq("id", args.submitterId);

  void logAnomaly({
    severity: "info",
    eventType: "bounty_payout_triggered",
    description: `tier ${args.tier} payout to submitter ${args.submitterId} for lead ${args.leadId}: $${amountUsdc} USDC (×${args.introMultiplier})`,
    context: {
      submitter_id: args.submitterId,
      lead_id: args.leadId,
      tier: args.tier,
      partnership_tier: args.partnershipTier ?? null,
      amount_usdc: amountUsdc,
      intro_multiplier: args.introMultiplier,
      payout_tx_signature: args.payoutTxSignature,
      paid_by: args.paidBy,
    },
  });

  return {
    id: (inserted as { id: number }).id,
    amountUsdc,
  };
}
