import type { Request, Response } from "express";
import { adminClient } from "../supabase";
import { requireUser } from "../auth";
import { errors } from "../errors";
import { updateDisplayNameSchema } from "../validators";

/**
 * Profile endpoints — read + display-name update.
 *
 * Auth: req.user.id from authRequired. user_id never read from body/
 * query/path.
 *
 * GET  /profile           — read calling user's display_name + meta
 * PATCH /profile/display-name
 *                          — update display_name with rate limit
 *                            (1 change / 24 hours per user)
 */

const DISPLAY_NAME_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  display_name_changed_at: string | null;
  created_at: string;
}

function shapeProfile(row: UserRow): Record<string, unknown> {
  return {
    user_id: row.id,
    display_name: row.display_name,
    display_name_changed_at: row.display_name_changed_at,
    created_at: row.created_at,
  };
}

export async function getProfileHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);
  const supabase = adminClient();

  const { data, error } = await supabase
    .from("users")
    .select("id, email, display_name, display_name_changed_at, created_at")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    errors.internal(res, `profile read: ${error.message}`);
    return;
  }
  if (!data) {
    // No public.users row — auth.users exists (we got past the JWT) but
    // the trigger failed to mirror. Surface as 500 since this is a
    // backend invariant violation, not a user-facing 404.
    errors.internal(res, "user has no public.users row — auth trigger may have failed");
    return;
  }

  res.json({ profile: shapeProfile(data as UserRow) });
}

export async function updateDisplayNameHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const user = requireUser(req);

  const parsed = updateDisplayNameSchema.safeParse(req.body);
  if (!parsed.success) {
    errors.invalidInput(res, parsed.error.issues[0]?.message ?? "invalid input", {
      issues: parsed.error.issues,
    });
    return;
  }
  const newName = parsed.data.display_name;

  const supabase = adminClient();

  // Read current state for rate-limit check + uniqueness check.
  const { data: current, error: readErr } = await supabase
    .from("users")
    .select("id, display_name, display_name_changed_at")
    .eq("id", user.id)
    .maybeSingle();
  if (readErr) {
    errors.internal(res, `profile read: ${readErr.message}`);
    return;
  }
  if (!current) {
    errors.internal(res, "user has no public.users row — auth trigger may have failed");
    return;
  }

  // No-op shortcut FIRST — setting your name to the value it already
  // has is not a "change", so it bypasses the rate limit and just
  // echoes current state. Rate limit only applies to actual mutations.
  if (current.display_name === newName) {
    const { data: row } = await supabase
      .from("users")
      .select("id, email, display_name, display_name_changed_at, created_at")
      .eq("id", user.id)
      .maybeSingle();
    res.json({ profile: shapeProfile(row as UserRow), changed: false });
    return;
  }

  // Rate limit: 1 change per 24 hours. The very first change has a NULL
  // display_name_changed_at, which is unconstrained.
  if (current.display_name_changed_at) {
    const lastChangeMs = new Date(current.display_name_changed_at).getTime();
    const elapsedMs = Date.now() - lastChangeMs;
    if (elapsedMs < DISPLAY_NAME_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((DISPLAY_NAME_RATE_LIMIT_MS - elapsedMs) / 1000);
      errors.rateLimited(
        res,
        "display_name can only be changed once per 24 hours",
        retryAfter,
        { last_changed_at: current.display_name_changed_at },
      );
      return;
    }
  }

  // Case-insensitive collision check. The DB has a unique index on
  // lower(display_name) which would also catch this, but a clean 409
  // is friendlier than parsing a Postgres unique-violation error.
  const { data: clash, error: clashErr } = await supabase
    .from("users")
    .select("id")
    .ilike("display_name", newName)
    .neq("id", user.id)
    .limit(1)
    .maybeSingle();
  if (clashErr) {
    errors.internal(res, `display_name uniqueness check: ${clashErr.message}`);
    return;
  }
  if (clash) {
    errors.displayNameTaken(res, newName);
    return;
  }

  const { data: updated, error: updateErr } = await supabase
    .from("users")
    .update({
      display_name: newName,
      display_name_changed_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select("id, email, display_name, display_name_changed_at, created_at")
    .maybeSingle();
  if (updateErr) {
    // Race: someone took the same name between our check and update.
    if (updateErr.message.includes("users_display_name_lower_unique")) {
      errors.displayNameTaken(res, newName);
      return;
    }
    if (updateErr.message.includes("users_display_name_length")
        || updateErr.message.includes("users_display_name_format")) {
      errors.invalidInput(res, updateErr.message);
      return;
    }
    errors.internal(res, `display_name update: ${updateErr.message}`);
    return;
  }
  if (!updated) {
    errors.internal(res, "display_name update returned no row");
    return;
  }

  res.json({ profile: shapeProfile(updated as UserRow), changed: true });
}
