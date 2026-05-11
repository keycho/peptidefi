import { BioHashApiError } from "./errors";

/**
 * Minimal options the SDK accepts at construction time. baseUrl is
 * trimmed of trailing slashes so callers can be sloppy about it.
 */
export interface BioHashClientOptions {
  /** Base URL of the BioHash API. Defaults to https://api.biohash.network. */
  baseUrl?: string;
  /**
   * Custom fetch implementation. Defaults to the global `fetch`. Useful
   * for unit tests and for runtimes that need a polyfill.
   */
  fetch?: typeof fetch;
  /**
   * Per-request timeout in milliseconds. Default 30_000. Set to 0 to
   * disable the SDK-side timeout (the underlying transport may still
   * enforce one).
   */
  timeoutMs?: number;
  /**
   * Max retry attempts on transient failures (5xx + network errors).
   * Default 3 (so up to 4 total requests). 429 responses are retried
   * separately, honoring Retry-After, and do not count against this.
   */
  maxRetries?: number;
  /**
   * Initial backoff in milliseconds for the exponential-backoff schedule
   * on retried requests. Default 250 — so 250ms, 500ms, 1000ms.
   */
  retryBackoffMs?: number;
  /**
   * Extra headers attached to every request. Useful for an
   * `X-Admin-Token` to bypass public rate limits in trusted callers.
   */
  headers?: Record<string, string>;
  /**
   * User-Agent header. Defaults to `@biohashnetwork/sdk/<version>`.
   * Ignored in browsers (the runtime overrides UA).
   */
  userAgent?: string;
}

const DEFAULT_BASE_URL = "https://api.biohash.network";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const SDK_VERSION = "0.1.0";

interface ResolvedOptions {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  headers: Record<string, string>;
}

function resolveOptions(opts: BioHashClientOptions): ResolvedOptions {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "BioHash SDK: no fetch implementation available. Pass `fetch` in client options or upgrade to Node 18+.",
    );
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.userAgent !== undefined) {
    headers["User-Agent"] = opts.userAgent;
  } else if (headers["User-Agent"] === undefined) {
    headers["User-Agent"] = `@biohashnetwork/sdk/${SDK_VERSION}`;
  }
  return {
    baseUrl,
    fetch: fetchImpl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryBackoffMs: opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
    headers,
  };
}

/** Internal: serialise primitives to URL query string, dropping `undefined`. */
function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP-date form
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) {
    const diff = Math.max(0, Math.ceil((date - Date.now()) / 1000));
    return diff;
  }
  return null;
}

/** Cap any Retry-After value so a malicious or buggy server can't pin the SDK. */
const MAX_RETRY_AFTER_SECONDS = 120;

export interface HttpRequest {
  method: "GET";
  path: string;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Thin HTTP layer with retries. Public because resource classes
 * receive it through their constructor — not part of the user-facing
 * API surface (no `client.http.*` methods documented).
 */
export class HttpClient {
  private readonly opts: ResolvedOptions;

  constructor(options: BioHashClientOptions = {}) {
    this.opts = resolveOptions(options);
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async request<T>(req: HttpRequest): Promise<T> {
    const url = `${this.opts.baseUrl}${req.path}${buildQuery(req.query)}`;
    let networkAttempt = 0;
    // 429s are retried independently and bounded so a server stuck on
    // "Retry-After: 1" forever cannot trap the SDK.
    let rateLimitAttempt = 0;
    const MAX_RATE_LIMIT_RETRIES = 5;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ctrl = new AbortController();
      const onAbort = (): void => ctrl.abort();
      if (req.signal) {
        if (req.signal.aborted) ctrl.abort();
        else req.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer =
        this.opts.timeoutMs > 0
          ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs)
          : null;

      let response: Response | null = null;
      let networkError: unknown = null;
      try {
        response = await this.opts.fetch(url, {
          method: req.method,
          headers: this.opts.headers,
          signal: ctrl.signal,
        });
      } catch (err) {
        networkError = err;
      } finally {
        if (timer) clearTimeout(timer);
        if (req.signal) req.signal.removeEventListener("abort", onAbort);
      }

      // Network failure (fetch threw — DNS, TCP, abort, etc.)
      if (response === null) {
        // Re-throw aborts unchanged so callers using AbortController
        // see the cancel rather than a retry-exhausted error.
        if (req.signal?.aborted) {
          throw new BioHashApiError({
            message: "request aborted by caller",
            status: 0,
            code: "ABORTED",
            url,
            cause: networkError,
          });
        }
        if (networkAttempt < this.opts.maxRetries) {
          const backoff =
            this.opts.retryBackoffMs * Math.pow(2, networkAttempt);
          networkAttempt += 1;
          await sleep(backoff);
          continue;
        }
        throw new BioHashApiError({
          message: `network request to ${url} failed: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
          status: 0,
          code: "NETWORK_ERROR",
          url,
          cause: networkError,
        });
      }

      // 5xx: retry with exponential backoff.
      if (response.status >= 500 && response.status < 600) {
        if (networkAttempt < this.opts.maxRetries) {
          const backoff =
            this.opts.retryBackoffMs * Math.pow(2, networkAttempt);
          networkAttempt += 1;
          // Drain the body so the connection can be reused.
          await response.text().catch(() => {});
          await sleep(backoff);
          continue;
        }
        throw await buildErrorFromResponse(response, url);
      }

      // 429: honor Retry-After, bounded.
      if (response.status === 429) {
        if (rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
          const raw = parseRetryAfter(response.headers.get("Retry-After"));
          const waitSeconds =
            raw === null
              ? Math.min(
                  MAX_RETRY_AFTER_SECONDS,
                  (this.opts.retryBackoffMs *
                    Math.pow(2, rateLimitAttempt)) /
                    1000,
                )
              : Math.min(MAX_RETRY_AFTER_SECONDS, raw);
          rateLimitAttempt += 1;
          await response.text().catch(() => {});
          await sleep(waitSeconds * 1000);
          continue;
        }
        throw await buildErrorFromResponse(response, url);
      }

      // Other 4xx: throw immediately, no retry.
      if (!response.ok) {
        throw await buildErrorFromResponse(response, url);
      }

      // Success — parse JSON.
      const text = await response.text();
      if (text.length === 0) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new BioHashApiError({
          message: `response from ${url} was not valid JSON`,
          status: response.status,
          code: "INVALID_JSON",
          url,
          cause: err,
          details: text.slice(0, 200),
        });
      }
    }
  }
}

async function buildErrorFromResponse(
  response: Response,
  url: string,
): Promise<BioHashApiError> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // fall through; leave parsed as null
    }
  }
  if (parsed && typeof parsed === "object") {
    const env = parsed as {
      code?: string;
      message?: string;
      retry_after_seconds?: number;
      details?: unknown;
    };
    return new BioHashApiError({
      message:
        env.message ??
        `BioHash API request failed: HTTP ${response.status}`,
      status: response.status,
      code: env.code ?? `HTTP_${response.status}`,
      ...(env.retry_after_seconds !== undefined
        ? { retryAfterSeconds: env.retry_after_seconds }
        : {}),
      ...(env.details !== undefined ? { details: env.details } : {}),
      url,
    });
  }
  return new BioHashApiError({
    message: `BioHash API request failed: HTTP ${response.status}`,
    status: response.status,
    code: `HTTP_${response.status}`,
    url,
    ...(text ? { details: text.slice(0, 200) } : {}),
  });
}
