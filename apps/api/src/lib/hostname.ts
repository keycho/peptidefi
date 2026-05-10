/**
 * Vendor-URL → canonical hostname for deduplication.
 *
 * Goals:
 *   - "https://www.example.com/products/foo?x=1" → "example.com"
 *   - "http://EXAMPLE.com" → "example.com" (lowercase)
 *   - "example.com/path" → "example.com" (no scheme tolerated)
 *   - Subdomains other than www are PRESERVED — shop.example.com is a
 *     separate vendor from blog.example.com. Only www is a known no-op
 *     marketing prefix.
 *
 * The unique-active-lead constraint in migration 0035 is keyed on this
 * normalized form, so changing the rules later requires a backfill.
 */

export function normalizeVendorHostname(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Tolerate scheme-less input by prepending https://.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.") && host.length > 4) {
    host = host.slice(4);
  }
  // Reject obvious junk — empty, single-label (no TLD), IP-like
  // numeric-only. The submission endpoint should also enforce a
  // sanity check upstream, but a defensive return-null here keeps
  // the dedup index clean.
  if (!host || !host.includes(".")) return null;
  return host;
}
