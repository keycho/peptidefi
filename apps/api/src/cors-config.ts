import type { CorsOptions } from "cors";

/**
 * CORS allow-list for the API.
 *
 * Permitted origins:
 *   - http://localhost:3000  / http://localhost:5173      (local dev)
 *   - http://127.0.0.1:3000  / http://127.0.0.1:5173       (local dev, IP form)
 *   - https://*.lovable.app  / https://*.lovable.dev       (Lovable previews)
 *   - https://*.lovableproject.com                         (Lovable previews, alt host)
 *   - Any origin listed in the CORS_ORIGINS env var
 *     (comma-separated, exact match — useful once we know the production
 *     custom domain).
 *
 * Same-origin requests (no Origin header) are always allowed — they
 * aren't CORS to begin with.
 *
 * credentials=true so the frontend can send Authorization: Bearer
 * cookies-style; combined with allowedHeaders, this is a permissive but
 * scoped policy. We tighten it (drop the localhost entries, lock to the
 * known production origin) once we have a real customer-facing domain.
 */

const STATIC_ALLOWED = new Set<string>([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

const LOVABLE_HOST_RE =
  /^https:\/\/[a-z0-9-]+\.(lovable\.app|lovable\.dev|lovableproject\.com)$/i;

function envOrigins(): Set<string> {
  const raw = process.env.CORS_ORIGINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function corsOptions(): CorsOptions {
  const extra = envOrigins();
  return {
    origin(origin, cb) {
      if (!origin) {
        // Same-origin / curl / server-to-server. Not a CORS request.
        cb(null, true);
        return;
      }
      if (STATIC_ALLOWED.has(origin)) return cb(null, true);
      if (extra.has(origin)) return cb(null, true);
      if (LOVABLE_HOST_RE.test(origin)) return cb(null, true);
      cb(new Error(`CORS: origin "${origin}" is not allow-listed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-idempotency-key"],
    maxAge: 86_400,
  };
}
