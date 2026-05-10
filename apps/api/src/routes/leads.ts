import type { Request, Response } from "express";
import { z } from "zod";
import { logAnomaly } from "@peptide-oracle/shared";

import { adminClientUntyped } from "../supabase";
import { sendError } from "../errors";
import { verifyWalletSignature } from "../lib/wallet-auth";
import { normalizeVendorHostname } from "../lib/hostname";
import { sendEmail } from "../lib/email";

/**
 * /api/leads/* — public surface for the vendor-discovery flow.
 *
 *   POST   /api/leads/submit          — create a lead (wallet sig)
 *   GET    /api/leads/my-leads        — submitter's own leads (wallet sig)
 *   GET    /api/leads/pipeline-status — public counts
 *   POST   /api/leads/check-vendor    — pre-flight URL check (wallet sig)
 *   GET    /api/leads/leaderboard     — public ranking
 *
 * Rate limits + CORS are wired in apps/api/src/index.ts at mount time.
 *
 * Auth model: wallet ed25519 signature (see lib/wallet-auth.ts). The
 * server NEVER consumes a SIWE-style nonce store — replay is bounded
 * by the SIGNATURE_TTL_MS window in the canonical signed message.
 */

const COHORT_CAP = 25;
const ACTIVE_LEAD_QUOTA = 5;
const NEW_LEAD_QUOTA_PER_MONTH = 5;

const ACTIVE_STATUSES = [
  "submitted",
  "accepted_pipeline",
  "vendor_responded",
] as const;

// ─── shared shapes ────────────────────────────────────────────────

const walletAuthSchema = z.object({
  wallet_address: z.string().min(32).max(64),
  signed_message: z.string().min(1).max(512),
  wallet_signature: z.string().min(64).max(128),
});

type WalletAuthFields = z.infer<typeof walletAuthSchema>;

function authenticate(
  body: unknown,
  res: Response,
): WalletAuthFields | null {
  const parsed = walletAuthSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return null;
  }
  const verdict = verifyWalletSignature(parsed.data);
  if (!verdict.ok) {
    sendError(res, 401, verdict.code, verdict.message);
    return null;
  }
  return parsed.data;
}

// ─── POST /api/leads/submit ──────────────────────────────────────

const legitEvidenceSchema = z.object({
  has_third_party_testing: z.boolean(),
  testing_provider: z.string().max(120).optional(),
  operating_months: z.number().int().nonnegative(),
  has_independent_reviews: z.boolean(),
  has_clear_business_presence: z.boolean(),
  other_evidence: z.string().max(1000).optional(),
});

const submitBodySchema = walletAuthSchema.extend({
  vendor_name: z.string().min(1).max(120),
  vendor_url: z.string().min(4).max(500),
  reason_for_relevance: z.string().min(50).max(2000),
  legitimacy_evidence: legitEvidenceSchema,
  suggested_tier: z.enum([
    "verified_listing",
    "verified_feed",
    "verified_reserve",
  ]),
  submitter_relationship: z.enum([
    "customer",
    "industry_contact",
    "no_relationship",
    "affiliated",
  ]),
  contact_suggestion: z.string().max(200).optional(),
  has_personal_contact: z.boolean(),
});

export async function submitLeadHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = authenticate(req.body, res);
  if (!auth) return;
  const parsed = submitBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const body = parsed.data;
  const supabase = adminClientUntyped();

  const hostname = normalizeVendorHostname(body.vendor_url);
  if (!hostname) {
    sendError(res, 400, "BAD_VENDOR_URL", "vendor_url could not be normalized to a hostname");
    return;
  }

  // 1. Resolve or create submitter row, gated by cohort cap.
  const { data: existing, error: subErr } = await supabase
    .from("submitters")
    .select("id, status, leads_submitted, leads_accepted, leads_converted, total_paid_usdc")
    .eq("wallet_address", body.wallet_address)
    .maybeSingle();
  if (subErr) {
    sendError(res, 500, "DB_ERROR", `submitters lookup failed: ${subErr.message}`);
    return;
  }

  let submitterId: number;
  if (existing) {
    if (existing.status === "banned" || existing.status === "suspended") {
      sendError(res, 403, "SUBMITTER_NOT_ACTIVE", `wallet is ${existing.status}`);
      return;
    }
    submitterId = existing.id;
  } else {
    // First-ever submission — must fit under the cohort cap.
    const { count, error: countErr } = await supabase
      .from("submitters")
      .select("id", { count: "exact", head: true });
    if (countErr) {
      sendError(res, 500, "DB_ERROR", `cohort count failed: ${countErr.message}`);
      return;
    }
    if ((count ?? 0) >= COHORT_CAP) {
      sendError(
        res,
        403,
        "COHORT_FULL",
        `first-cohort cap of ${COHORT_CAP} submitters reached; waitlist coming soon`,
      );
      return;
    }
    const { data: created, error: createErr } = await supabase
      .from("submitters")
      .insert({ wallet_address: body.wallet_address, status: "active" })
      .select("id")
      .single();
    if (createErr || !created) {
      sendError(res, 500, "DB_ERROR", `submitter create failed: ${createErr?.message ?? "no row"}`);
      return;
    }
    submitterId = (created as { id: number }).id;
  }

  // 2. Quota: max 5 active leads.
  const { count: activeCount, error: activeErr } = await supabase
    .from("vendor_leads")
    .select("id", { count: "exact", head: true })
    .eq("submitter_id", submitterId)
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  if (activeErr) {
    sendError(res, 500, "DB_ERROR", `active-quota check failed: ${activeErr.message}`);
    return;
  }
  if ((activeCount ?? 0) >= ACTIVE_LEAD_QUOTA) {
    sendError(
      res,
      429,
      "ACTIVE_LEAD_QUOTA",
      `submitter has ${activeCount} active leads; max ${ACTIVE_LEAD_QUOTA}`,
    );
    return;
  }

  // 3. Quota: max 5 NEW submissions in the last 30 days.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: monthCount, error: monthErr } = await supabase
    .from("vendor_leads")
    .select("id", { count: "exact", head: true })
    .eq("submitter_id", submitterId)
    .gte("submitted_at", monthAgo);
  if (monthErr) {
    sendError(res, 500, "DB_ERROR", `month-quota check failed: ${monthErr.message}`);
    return;
  }
  if ((monthCount ?? 0) >= NEW_LEAD_QUOTA_PER_MONTH) {
    sendError(
      res,
      429,
      "MONTHLY_QUOTA",
      `submitter has ${monthCount} submissions in last 30d; max ${NEW_LEAD_QUOTA_PER_MONTH}`,
    );
    return;
  }

  // 4. Hostname dedup — DB constraint also enforces this; we
  //    pre-check so we can return a clean 409 rather than a generic
  //    duplicate-row 500 from the unique index.
  const { data: dupe, error: dupeErr } = await supabase
    .from("vendor_leads")
    .select("id, status, submitter_id")
    .eq("vendor_url_hostname", hostname)
    .in("status", ACTIVE_STATUSES as unknown as string[])
    .maybeSingle();
  if (dupeErr) {
    sendError(res, 500, "DB_ERROR", `dedup check failed: ${dupeErr.message}`);
    return;
  }
  if (dupe) {
    sendError(
      res,
      409,
      "VENDOR_ALREADY_IN_PIPELINE",
      `${hostname} already has an active lead (status=${dupe.status})`,
    );
    return;
  }

  // 5. Insert the lead.
  const { data: insertedLead, error: insertErr } = await supabase
    .from("vendor_leads")
    .insert({
      submitter_id: submitterId,
      vendor_name: body.vendor_name,
      vendor_url: body.vendor_url,
      vendor_url_hostname: hostname,
      reason_for_relevance: body.reason_for_relevance,
      legitimacy_evidence: body.legitimacy_evidence,
      suggested_tier: body.suggested_tier,
      submitter_relationship: body.submitter_relationship,
      contact_suggestion: body.contact_suggestion ?? null,
      has_personal_contact: body.has_personal_contact,
      status: "submitted",
    })
    .select("id, status")
    .single();
  if (insertErr || !insertedLead) {
    sendError(res, 500, "DB_ERROR", `lead insert failed: ${insertErr?.message ?? "no row"}`);
    return;
  }

  // 6. Bump submitter count + log + email.
  await supabase
    .from("submitters")
    .update({ leads_submitted: ((existing?.leads_submitted ?? 0) + 1) })
    .eq("id", submitterId);

  void logAnomaly({
    severity: "info",
    eventType: "lead_submitted",
    description: `lead ${(insertedLead as { id: number }).id} for ${body.vendor_name} (${hostname}) by submitter ${submitterId}`,
    vendorId: hostname,
    context: {
      lead_id: (insertedLead as { id: number }).id,
      submitter_id: submitterId,
      suggested_tier: body.suggested_tier,
      relationship: body.submitter_relationship,
      affiliated: body.submitter_relationship === "affiliated",
      has_personal_contact: body.has_personal_contact,
    },
  });
  void sendEmail({
    to: `wallet:${body.wallet_address}`,
    template: "lead_received",
    data: {
      lead_id: (insertedLead as { id: number }).id,
      vendor_name: body.vendor_name,
      review_eta_days: 14,
    },
  });

  res.status(201).json({
    lead_id: (insertedLead as { id: number }).id,
    status: (insertedLead as { status: string }).status,
    submitter_id: submitterId,
  });
}

// ─── GET /api/leads/my-leads (POST so wallet sig fits in body) ───

export async function myLeadsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = authenticate(req.body, res);
  if (!auth) return;
  const supabase = adminClientUntyped();
  const { data: submitter, error: subErr } = await supabase
    .from("submitters")
    .select("id, leads_submitted, leads_accepted, leads_converted, total_paid_usdc")
    .eq("wallet_address", auth.wallet_address)
    .maybeSingle();
  if (subErr) {
    sendError(res, 500, "DB_ERROR", subErr.message);
    return;
  }
  if (!submitter) {
    res.json({ submitter: null, leads: [], payouts: [] });
    return;
  }
  const { data: leads, error: leadsErr } = await supabase
    .from("vendor_leads")
    .select(
      "id, vendor_name, vendor_url, status, suggested_tier, submitted_at, reviewed_at, accepted_at, converted_at, expired_at, rejection_reason, tier1_recognised_at, tier2_paid_at, tier2_amount_usdc, tier3_paid_at, tier3_amount_usdc",
    )
    .eq("submitter_id", (submitter as { id: number }).id)
    .order("submitted_at", { ascending: false });
  if (leadsErr) {
    sendError(res, 500, "DB_ERROR", leadsErr.message);
    return;
  }
  const { data: payouts, error: payErr } = await supabase
    .from("bounty_payouts")
    .select("id, lead_id, tier, amount_usdc, intro_multiplier, payout_tx_signature, paid_at")
    .eq("submitter_id", (submitter as { id: number }).id)
    .order("paid_at", { ascending: false });
  if (payErr) {
    sendError(res, 500, "DB_ERROR", payErr.message);
    return;
  }
  res.json({ submitter, leads: leads ?? [], payouts: payouts ?? [] });
}

// ─── GET /api/leads/pipeline-status ──────────────────────────────

export async function pipelineStatusHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const [vendors, submitters] = await Promise.all([
    supabase.from("partner_vendors").select("status"),
    supabase.from("submitters_public").select("id", { count: "exact", head: true }),
  ]);
  if (vendors.error) {
    sendError(res, 500, "DB_ERROR", `partner_vendors: ${vendors.error.message}`);
    return;
  }
  if (submitters.error) {
    sendError(res, 500, "DB_ERROR", `submitters: ${submitters.error.message}`);
    return;
  }
  const counts = {
    in_pipeline: 0,
    verified: 0,
    declined: 0,
  };
  for (const r of (vendors.data ?? []) as Array<{ status: string }>) {
    if (r.status === "in_pipeline" || r.status === "inquired") counts.in_pipeline += 1;
    else if (r.status.startsWith("verified_")) counts.verified += 1;
    else if (r.status === "declined" || r.status === "do_not_contact") counts.declined += 1;
  }
  res
    .set("cache-control", "public, max-age=60")
    .json({
      vendors: counts,
      submitters_registered: submitters.count ?? 0,
    });
}

// ─── POST /api/leads/check-vendor ────────────────────────────────

const checkVendorBody = walletAuthSchema.extend({
  vendor_url: z.string().min(4).max(500),
});

export async function checkVendorHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = authenticate(req.body, res);
  if (!auth) return;
  const parsed = checkVendorBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const hostname = normalizeVendorHostname(parsed.data.vendor_url);
  if (!hostname) {
    res.json({
      in_pipeline: false,
      can_submit: false,
      reason_if_blocked: "vendor_url is not a parseable hostname",
    });
    return;
  }
  const supabase = adminClientUntyped();
  // Check active leads + partner_vendors.
  const [activeLeadQ, vendorQ] = await Promise.all([
    supabase
      .from("vendor_leads")
      .select("id, status")
      .eq("vendor_url_hostname", hostname)
      .in("status", ACTIVE_STATUSES as unknown as string[])
      .maybeSingle(),
    supabase
      .from("partner_vendors")
      .select("status")
      .ilike("vendor_url", `%${hostname}%`)
      .maybeSingle(),
  ]);
  const activeLead = activeLeadQ.data as { status: string } | null;
  const partner = vendorQ.data as { status: string } | null;
  if (activeLead) {
    res.json({
      in_pipeline: true,
      status: "in_pipeline",
      can_submit: false,
      reason_if_blocked: `vendor already has an active community lead (status=${activeLead.status})`,
    });
    return;
  }
  if (partner) {
    if (partner.status.startsWith("verified_")) {
      res.json({
        in_pipeline: true,
        status: "verified",
        can_submit: false,
        reason_if_blocked: "vendor is already a verified partner",
      });
      return;
    }
    if (partner.status === "declined" || partner.status === "do_not_contact") {
      res.json({
        in_pipeline: true,
        status: "declined",
        can_submit: false,
        reason_if_blocked: `vendor previously ${partner.status}; do not re-submit`,
      });
      return;
    }
  }
  res.json({ in_pipeline: false, can_submit: true });
}

// ─── GET /api/leads/leaderboard ──────────────────────────────────

export async function leaderboardHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const limit = Math.min(
    Math.max(Number.parseInt((req.query.limit as string) ?? "50", 10) || 50, 1),
    200,
  );
  const supabase = adminClientUntyped();
  const { data, error } = await supabase
    .from("submitters_public")
    .select(
      "wallet_address, leads_submitted, leads_accepted, leads_converted, total_paid_usdc",
    )
    .eq("status", "active")
    .order("leads_converted", { ascending: false })
    .order("leads_accepted", { ascending: false })
    .limit(limit);
  if (error) {
    sendError(res, 500, "DB_ERROR", error.message);
    return;
  }
  res
    .set("cache-control", "public, max-age=60")
    .json({
      leaderboard: ((data ?? []) as Array<{
        wallet_address: string;
        leads_submitted: number;
        leads_accepted: number;
        leads_converted: number;
        total_paid_usdc: number;
      }>).map((r) => ({
        wallet: anonymiseWallet(r.wallet_address),
        leads_submitted: r.leads_submitted,
        leads_accepted: r.leads_accepted,
        leads_converted: r.leads_converted,
        total_earned_usdc: r.total_paid_usdc,
        // verified_submitter: leads_accepted > 0 — leaderboard uses
        // it for the "Verified Submitter" badge. Tier 1 is
        // recognition only; this counter IS the recognition.
        verified_submitter: r.leads_accepted > 0,
      })),
    });
}

function anonymiseWallet(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export const _internal = { anonymiseWallet };
