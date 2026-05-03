/**
 * Project identity constants for on-chain memos and the verification API.
 *
 * Both fields are static at protocol v=2 — they're not expected to
 * change during the lifetime of v=2. A v=3 protocol bump that
 * renamed the project would shift these values; the version field
 * in each memo body distinguishes the eras.
 *
 * `BIOHASH_PROJECT` and `BIOHASH_URL` enter the canonical memo body
 * for both cycle commits (§02.2.2) and TWAP commits (§02.2.3),
 * sorting alphabetically into their canonical positions:
 *
 *   cycle memo (v=2):
 *     completed_at, cycle_id, merkle_root, observation_count,
 *     project, started_at, type, url, v
 *
 *   TWAP memo (v=2):
 *     algo, computed_at, observation_set_root, peptide_code,
 *     project, twap_value, type, url, v, window_end, window_start
 *
 * Note that `url` is recorded WITHOUT a protocol scheme (no
 * "https://"). The discovery convention is "show the user-facing
 * apex domain that any client can prepend a protocol to". This
 * minimises memo bytes and avoids ambiguity when (later) we add
 * subdomains or protocol upgrades.
 */

export const BIOHASH_PROJECT = "biohash";
export const BIOHASH_URL = "biohash.network";
