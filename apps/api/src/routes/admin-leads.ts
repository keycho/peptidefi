import type { Request, Response } from "express";
import { z } from "zod";
import { logAnomaly } from "@peptide-oracle/shared";

import { adminClientUntyped } from "../supabase";
import { sendError } from "../errors";
import { recordPayout } from "../lib/bounty";
import { sendEmail } from "../lib/email";

/**
 * /api/admin/leads/* — internal review + bounty surface.
 *
 *   GET  /api/admin/leads/queue              — submitted leads, oldest first
 *   POST /api/admin/leads/:id/review         — accept | reject
 *   POST /api/admin/leads/:id/progress       — Tier 2 / Tier 3 milestone
 *   POST /api/admin/submitters/:id/violation — record a conduct breach
 *
 * All four require `Authorization: Bearer <ADMIN_API_TOKEN>` (wired
 * at mount time via requireAdminToken middleware in index.ts). The
 * admin token is separate from SUPABASE_SECRET_KEY so it can be
 * rotated independently and audited.
 */

// ─── GET /api/admin/leads/queue ──────────────────────────────────

export async function adminQueueHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const { data, error } = await supabase
    .from("vendor_leads")
    .select(
      "id, submitter_id, vendor_name, vendor_url, vendor_url_hostname, reason_for_relevance, legitimacy_evidence, suggested_tier, submitter_relationship, contact_suggestion, has_personal_contact, status, submitted_at",
    )
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true })
    .limit(200);
  if (error) {
    sendError(res, 500, "DB_ERROR", error.message);
    return;
  }
  // Hydrate submitter wallet for each lead so the reviewer doesn't
  // need an extra round-trip per row.
  const submitterIds = [...new Set((data ?? []).map((r) => r.submitter_id))];
  const submitters = submitterIds.length
    ? await supabase
        .from("submitters")
        .select("id, wallet_address, status, leads_submitted, leads_accepted, leads_converted")
        .in("id", submitterIds)
    : { data: [], error: null };
  if (submitters.error) {
    sendError(res, 500, "DB_ERROR", submitters.error.message);
    return;
  }
  const subById = new Map(
    (submitters.data ?? []).map((s) => [
      (s as { id: number }).id,
      s as Record<string, unknown>,
    ]),
  );
  res.json({
    queue: (data ?? []).map((lead) => ({
      ...lead,
      submitter: subById.get(lead.submitter_id) ?? null,
    })),
  });
}

// ─── POST /api/admin/leads/:id/review ────────────────────────────

const reviewBody = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accept"),
    intro_path_approved: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    rejection_reason: z.string().min(5).max(500),
    notes: z.string().max(2000).optional(),
  }),
]);

export async function adminReviewHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) {
    sendError(res, 400, "BAD_REQUEST", ":id must be a positive integer");
    return;
  }
  const parsed = reviewBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const supabase = adminClientUntyped();
  const { data: lead, error: leadErr } = await supabase
    .from("vendor_leads")
    .select(
      "id, submitter_id, vendor_name, vendor_url, vendor_url_hostname, status, has_personal_contact, submitter_relationship, suggested_tier",
    )
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    sendError(res, 500, "DB_ERROR", leadErr.message);
    return;
  }
  if (!lead) {
    sendError(res, 404, "NOT_FOUND", `lead ${id} not found`);
    return;
  }
  if ((lead as { status: string }).status !== "submitted") {
    sendError(
      res,
      409,
      "BAD_LEAD_STATE",
      `lead ${id} is in status ${(lead as { status: string }).status}; only 'submitted' can be reviewed`,
    );
    return;
  }
  const submitterId = (lead as { submitter_id: number }).submitter_id;
  const { data: submitterRow } = await supabase
    .from("submitters")
    .select("wallet_address, leads_accepted")
    .eq("id", submitterId)
    .single();

  if (parsed.data.decision === "reject") {
    await supabase
      .from("vendor_leads")
      .update({
        status: "rejected",
        rejection_reason: parsed.data.rejection_reason,
        reviewed_at: new Date().toISOString(),
        notes: parsed.data.notes ?? null,
      })
      .eq("id", id);
    void logAnomaly({
      severity: "info",
      eventType: "lead_rejected",
      description: `lead ${id} (${(lead as { vendor_name: string }).vendor_name}) rejected: ${parsed.data.rejection_reason}`,
      vendorId: (lead as { vendor_url_hostname: string }).vendor_url_hostname,
      context: {
        lead_id: id,
        submitter_id: submitterId,
        rejection_reason: parsed.data.rejection_reason,
      },
    });
    void sendEmail({
      to: `wallet:${(submitterRow as { wallet_address: string } | null)?.wallet_address ?? ""}`,
      template: "lead_rejected",
      data: { lead_id: id, vendor_name: (lead as { vendor_name: string }).vendor_name, reason: parsed.data.rejection_reason },
    });
    res.json({ ok: true, lead_id: id, new_status: "rejected" });
    return;
  }

  // ── ACCEPT ──────────────────────────────────────────────────
  // Tier 1 is RECOGNITION ONLY (no payout). The submitter gets:
  //   - leads_accepted counter incremented (leaderboard placement)
  //   - "Verified Submitter" status implicitly (no schema column;
  //     the leaderboard renders any submitter with leads_accepted>0
  //     as verified)
  //   - tier1_recognised_at timestamp on the vendor_leads row
  // No bounty_payouts row, no USDC. Tier 2 + Tier 3 payouts fire
  // from /progress only.
  const introPath =
    parsed.data.intro_path_approved === true &&
    (lead as { has_personal_contact: boolean }).has_personal_contact === true;

  // Upsert partner_vendors row with status=in_pipeline.
  const { data: partner, error: partnerErr } = await supabase
    .from("partner_vendors")
    .upsert(
      {
        vendor_name: (lead as { vendor_name: string }).vendor_name,
        vendor_url: (lead as { vendor_url: string }).vendor_url,
        status: "in_pipeline",
        origin: "community_lead",
        source_lead_id: id,
        notes: parsed.data.notes ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "vendor_name" },
    )
    .select("id")
    .single();
  if (partnerErr) {
    sendError(res, 500, "DB_ERROR", `partner upsert failed: ${partnerErr.message}`);
    return;
  }
  const partnerId = (partner as { id: number }).id;

  // Update lead — accepted, link to partner, mark intro path used,
  // stamp tier1 recognition timestamp.
  const nowIso = new Date().toISOString();
  await supabase
    .from("vendor_leads")
    .update({
      status: "accepted_pipeline",
      reviewed_at: nowIso,
      accepted_at: nowIso,
      tier1_recognised_at: nowIso,
      vendor_id: partnerId,
      intro_path_used: introPath,
      notes: parsed.data.notes ?? null,
    })
    .eq("id", id);

  // Bump submitter accepted count.
  await supabase
    .from("submitters")
    .update({
      leads_accepted:
        ((submitterRow as { leads_accepted: number } | null)?.leads_accepted ?? 0) + 1,
    })
    .eq("id", submitterId);

  void logAnomaly({
    severity: "info",
    eventType: "lead_accepted",
    description: `lead ${id} accepted; partner_vendors.${partnerId} in_pipeline (recognition only — no Tier 1 payout)`,
    vendorId: (lead as { vendor_url_hostname: string }).vendor_url_hostname,
    context: {
      lead_id: id,
      submitter_id: submitterId,
      partner_vendor_id: partnerId,
      intro_path: introPath,
      tier1: "recognition_only",
    },
  });

  void sendEmail({
    to: `wallet:${(submitterRow as { wallet_address: string } | null)?.wallet_address ?? ""}`,
    template: "lead_accepted",
    data: {
      lead_id: id,
      vendor_name: (lead as { vendor_name: string }).vendor_name,
      tier1: "recognition_only",
    },
  });

  res.json({
    ok: true,
    lead_id: id,
    new_status: "accepted_pipeline",
    partner_vendor_id: partnerId,
    tier1: "recognition_only",
    intro_path: introPath,
  });
}

// ─── POST /api/admin/leads/:id/progress ──────────────────────────

const progressBody = z.discriminatedUnion("milestone", [
  z.object({
    milestone: z.literal("vendor_responded"),
    notes: z.string().max(2000).optional(),
  }),
  z.object({
    milestone: z.literal("vendor_verified"),
    partnership_tier: z.enum([
      "verified_listing",
      "verified_feed",
      "verified_reserve",
    ]),
    notes: z.string().max(2000).optional(),
  }),
]);

export async function adminProgressHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) {
    sendError(res, 400, "BAD_REQUEST", ":id must be a positive integer");
    return;
  }
  const parsed = progressBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const supabase = adminClientUntyped();
  const { data: lead, error: leadErr } = await supabase
    .from("vendor_leads")
    .select(
      "id, submitter_id, vendor_name, vendor_url_hostname, status, vendor_id, intro_path_used, submitter_relationship",
    )
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    sendError(res, 500, "DB_ERROR", leadErr.message);
    return;
  }
  if (!lead) {
    sendError(res, 404, "NOT_FOUND", `lead ${id} not found`);
    return;
  }
  const leadRow = lead as {
    submitter_id: number;
    vendor_name: string;
    vendor_url_hostname: string;
    status: string;
    vendor_id: number | null;
    intro_path_used: boolean;
    submitter_relationship: string;
  };

  // Validate state transition.
  const expected: Record<string, string> = {
    vendor_responded: "accepted_pipeline",
    vendor_verified: "vendor_responded",
  };
  if (leadRow.status !== expected[parsed.data.milestone]) {
    sendError(
      res,
      409,
      "BAD_LEAD_STATE",
      `cannot ${parsed.data.milestone} from ${leadRow.status}; need ${expected[parsed.data.milestone]}`,
    );
    return;
  }

  // Affiliated submitters are disqualified from bounty payouts
  // per the disclosure rule. We still record the milestone — they
  // just don't get the USDC.
  const affiliated = leadRow.submitter_relationship === "affiliated";
  const introMul = leadRow.intro_path_used ? 1.5 : 1.0;
  const tier: 2 | 3 = parsed.data.milestone === "vendor_responded" ? 2 : 3;

  let payout = null as { id: number; amountUsdc: number } | null;
  if (!affiliated) {
    try {
      payout = await recordPayout({
        supabase,
        submitterId: leadRow.submitter_id,
        leadId: id,
        tier,
        // Tier 3 amount varies by partnership tier ($100/$250/$500
        // for listing/feed/reserve). Tier 2 is flat $25.
        partnershipTier:
          tier === 3 && parsed.data.milestone === "vendor_verified"
            ? parsed.data.partnership_tier
            : undefined,
        introMultiplier: introMul,
        payoutTxSignature: null,
        paidBy: "admin-progress",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "PAYOUT_FAILED", msg);
      return;
    }
  }

  // Update lead state + tier USDC amounts.
  const leadUpdate: Record<string, unknown> = {
    status: parsed.data.milestone,
    notes: parsed.data.notes ?? null,
  };
  if (tier === 2) {
    // responded_at = the canonical entry timestamp for the
    // vendor_responded state. The lead-expiry sweeper measures the
    // 30-day stalled-after-response window from this column, NOT
    // from accepted_at (which would expire freshly-responded leads
    // any time the response landed >30d after acceptance). Set
    // unconditionally — even for affiliated submitters where
    // tier2_paid_at stays null, responded_at is what gates expiry.
    leadUpdate.responded_at = new Date().toISOString();
    leadUpdate.tier2_paid_at = new Date().toISOString();
    leadUpdate.tier2_amount_usdc = payout?.amountUsdc ?? 0;
  } else {
    leadUpdate.converted_at = new Date().toISOString();
    leadUpdate.tier3_paid_at = new Date().toISOString();
    leadUpdate.tier3_amount_usdc = payout?.amountUsdc ?? 0;
  }
  await supabase.from("vendor_leads").update(leadUpdate).eq("id", id);

  if (parsed.data.milestone === "vendor_verified" && leadRow.vendor_id) {
    await supabase
      .from("partner_vendors")
      .update({
        status: parsed.data.partnership_tier,
        joined_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadRow.vendor_id);
    // Bump submitter converted count.
    const { data: sub } = await supabase
      .from("submitters")
      .select("leads_converted")
      .eq("id", leadRow.submitter_id)
      .single();
    await supabase
      .from("submitters")
      .update({
        leads_converted:
          ((sub as { leads_converted: number } | null)?.leads_converted ?? 0) + 1,
      })
      .eq("id", leadRow.submitter_id);
  }

  void logAnomaly({
    severity: "info",
    eventType: "lead_progressed",
    description: `lead ${id} → ${parsed.data.milestone}`,
    vendorId: leadRow.vendor_url_hostname,
    context: {
      lead_id: id,
      submitter_id: leadRow.submitter_id,
      milestone: parsed.data.milestone,
      partnership_tier:
        parsed.data.milestone === "vendor_verified"
          ? parsed.data.partnership_tier
          : null,
      payout,
      intro_path: leadRow.intro_path_used,
      affiliated_submitter: affiliated,
    },
  });

  const { data: subForEmail } = await supabase
    .from("submitters")
    .select("wallet_address")
    .eq("id", leadRow.submitter_id)
    .single();
  void sendEmail({
    to: `wallet:${(subForEmail as { wallet_address: string } | null)?.wallet_address ?? ""}`,
    template: "lead_milestone_hit",
    data: {
      lead_id: id,
      milestone: parsed.data.milestone,
      tier,
      payout,
    },
  });

  res.json({
    ok: true,
    lead_id: id,
    new_status: parsed.data.milestone,
    payout,
    affiliated_no_bounty: affiliated,
  });
}

// ─── POST /api/admin/submitters/:id/violation ────────────────────

const violationBody = z.object({
  violation_type: z.string().min(1).max(120),
  details: z.string().min(1).max(2000),
  action: z.enum(["warning", "suspend", "ban", "clawback"]),
  reported_by: z.string().min(1).max(120),
  pending_clawback_amount_usdc: z.number().nonnegative().optional(),
});

export async function adminViolationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isFinite(id)) {
    sendError(res, 400, "BAD_REQUEST", ":id must be a positive integer");
    return;
  }
  const parsed = violationBody.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const supabase = adminClientUntyped();
  const { data: submitter } = await supabase
    .from("submitters")
    .select("id, wallet_address, status")
    .eq("id", id)
    .maybeSingle();
  if (!submitter) {
    sendError(res, 404, "NOT_FOUND", `submitter ${id} not found`);
    return;
  }
  const { data: violation, error: insertErr } = await supabase
    .from("submitter_violations")
    .insert({
      submitter_id: id,
      reported_by: parsed.data.reported_by,
      violation_type: parsed.data.violation_type,
      details: parsed.data.details,
      action_taken: parsed.data.action,
      pending_clawback_amount_usdc: parsed.data.pending_clawback_amount_usdc ?? null,
    })
    .select("id")
    .single();
  if (insertErr || !violation) {
    sendError(res, 500, "DB_ERROR", insertErr?.message ?? "insert returned no row");
    return;
  }

  // Update submitter status if the action escalates state.
  let newStatus: string | null = null;
  if (parsed.data.action === "ban") newStatus = "banned";
  else if (parsed.data.action === "suspend") newStatus = "suspended";
  if (newStatus) {
    await supabase
      .from("submitters")
      .update({ status: newStatus, ban_reason: parsed.data.details })
      .eq("id", id);
    void logAnomaly({
      severity: "warn",
      eventType: "submitter_banned",
      description: `submitter ${id} → ${newStatus}: ${parsed.data.violation_type}`,
      context: {
        submitter_id: id,
        violation_id: (violation as { id: number }).id,
        violation_type: parsed.data.violation_type,
        action: parsed.data.action,
        reported_by: parsed.data.reported_by,
      },
    });
    void sendEmail({
      to: `wallet:${(submitter as { wallet_address: string }).wallet_address}`,
      template: "submitter_banned",
      data: {
        violation_type: parsed.data.violation_type,
        details: parsed.data.details,
        action: parsed.data.action,
      },
    });
  }
  res.json({
    ok: true,
    violation_id: (violation as { id: number }).id,
    submitter_status: newStatus ?? (submitter as { status: string }).status,
  });
}
