// AD-13 KV result cache.
//
// Per the spec, branching-search results are cacheable by
// `(project_id, query_hash, corpus_event_max)`. The cache lives on a KV
// namespace bound as `BRANCHING_SEARCH_KV`. Binding is optional — when
// absent, every request runs the algorithm fresh and nothing is cached.
//
// Provisioning (not done here):
//   wrangler kv:namespace create BRANCHING_SEARCH_KV
//   wrangler kv:namespace create BRANCHING_SEARCH_KV --env staging
// then drop the returned ids into sync-worker/wrangler.toml as
//   [[kv_namespaces]] binding = "BRANCHING_SEARCH_KV"  id = "<prod-id>"
//   [[env.development.kv_namespaces]] binding = "BRANCHING_SEARCH_KV"
//     id = "<staging-id>"
//
// Until the namespace is provisioned the code stays a no-op and the route
// behaves identically to the uncached path.

export interface CacheEnv {
  AQUILLA_PG?: AquillaDb
  BRANCHING_SEARCH_KV?: KVNamespace
}

/**
 * Resolves the max source-side `event_id` for the project's effective
 * source corpus (this project for self-contained / source-only; the
 * upstream for linked targets). Lexicographic max on UUIDv7 is the same
 * as chronological max — the v7 timestamp prefix is the leading bytes.
 *
 * Soft-fails to `null` on any error; `null` corpusEventMax disables the
 * cache (no key can be built without it).
 */
export async function resolveCorpusEventMax(
  env: Pick<CacheEnv, "AQUILLA_PG">,
  sourceProjectId: string,
): Promise<string | null> {
  if (!env.AQUILLA_PG) return null
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT MAX(event_id) AS max_id FROM cells WHERE project_id = ? AND side = 'source'",
    )
      .bind(sourceProjectId)
      .first<{ max_id: string | null }>()
    return row?.max_id ?? null
  } catch {
    return null
  }
}

/** Hash the per-request request parameters into a stable string. SHA-256
 *  via Web Crypto — available in Workers. */
export async function hashQueryParams(parts: {
  q: string
  topK: number
  validatedOnly: boolean
  excludeCellId: string | null
}): Promise<string> {
  const payload = [
    parts.q,
    String(parts.topK),
    parts.validatedOnly ? "1" : "0",
    parts.excludeCellId ?? "",
  ].join(" ")
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  )
  // Hex encode — KV keys are strings, hex is portable and short enough.
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Cache key version prefix — bump if the response shape changes so old
 *  entries get ignored without manual KV cleanup. */
const CACHE_KEY_VERSION = "v1"

export function buildCacheKey(
  projectId: string,
  corpusEventMax: string,
  queryHash: string,
): string {
  return `bs:${CACHE_KEY_VERSION}:${projectId}:${corpusEventMax}:${queryHash}`
}

/**
 * TTL on cached entries. Long enough that repeated retries within a user
 * session are a hit; short enough that an out-of-band settings change
 * (project_settings.branchingSearch tunables — keyed separately from
 * corpus_event_max) self-heals within a minute.
 */
export const CACHE_TTL_SECONDS = 60
