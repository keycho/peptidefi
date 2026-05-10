/**
 * Transactional email — provider-stub for MVP.
 *
 * The vendor-discovery flow has 7 lifecycle moments that need an
 * email (lead_received, lead_accepted, lead_rejected,
 * lead_milestone_hit, lead_expired, partner_inquiry,
 * submitter_banned). For MVP we just LOG the would-be send to
 * stdout AND fire an anomaly entry so ops can verify the trigger
 * fired even before a real provider (Resend / Postmark) is wired.
 *
 * To plug in a real provider:
 *   1. Add provider env vars (e.g. RESEND_API_KEY).
 *   2. Replace the body of `sendEmail` below with a real fetch call.
 *   3. Templates can stay declared as the EmailTemplate union — the
 *      provider's template-id mapping plugs in here, not in callers.
 *
 * Wallet-only submitters: the spec talks about emailing submitters
 * but submitters are identified by wallet, not email address. For
 * now `to` is permitted to be either an email OR a wallet pseudo-
 * address ("wallet:<base58>") — the stub just logs whatever it was
 * given. A real provider integration would gate on whether the
 * submitter has supplied an opt-in email; absence is fine and the
 * wallet-pseudo-address branch becomes a no-op.
 */

import { logAnomaly } from "@peptide-oracle/shared";

export type EmailTemplate =
  | "lead_received"
  | "lead_accepted"
  | "lead_rejected"
  | "lead_milestone_hit"
  | "lead_expired"
  | "partner_inquiry"
  | "submitter_banned";

export interface SendEmailArgs {
  to: string;
  template: EmailTemplate;
  /** Template variables. Logged as JSON; not user-rendered yet. */
  data: Record<string, unknown>;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  // Stub: log + record an anomaly so the operations log surfaces
  // every would-be send. Severity 'info' — these aren't errors,
  // just operational beacons during the MVP window before a real
  // provider lands.
  console.log(
    `[email-stub] template=${args.template} to=${args.to} data=${JSON.stringify(args.data)}`,
  );
  void logAnomaly({
    severity: "info",
    eventType: "email_stub_send",
    description: `would-send email template=${args.template} to=${args.to}`,
    context: { template: args.template, to: args.to, data: args.data },
  });
}
