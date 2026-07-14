// Opaque cursor pagination for the external read surface (AGENT-API §4:
// "Cursor pagination on all list endpoints").
//
// Honesty note: every read this module paginates for
// (`queryScopedSearch`/`queryScopedExact` in scoped-search.ts, the manual
// event-history query in read-routes.ts) only supports limit/offset under
// the hood — there is no keyset the underlying query exposes. So the cursor
// here is base64url of `{ offset }`, exactly like the pre-existing cursor in
// cells-read-route.ts. It is still opaque to callers (they must not
// construct or interpret it), but it is NOT a stable keyset cursor: rows
// inserted/deleted between pages can shift the offset window (a classic
// offset-pagination caveat). Callers needing skew-proof pagination should ask
// for a keyset-backed read instead of relying on this.

export interface OffsetCursor {
  offset: number
}

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  return atob(padded + pad)
}

/** Encode an offset into an opaque cursor string. */
export function encodeCursor(offset: number): string {
  return toBase64Url(JSON.stringify({ offset } satisfies OffsetCursor))
}

/** Decode a cursor string back to an offset. Invalid/missing cursors decode
 *  to 0 (start of the list) rather than erroring — an external caller
 *  replaying a stale or hand-edited cursor should get page 1, not a 500. */
export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(fromBase64Url(cursor)) as Partial<OffsetCursor>
    if (typeof parsed.offset === "number" && parsed.offset >= 0 && Number.isFinite(parsed.offset)) {
      return parsed.offset
    }
    return 0
  } catch {
    return 0
  }
}

export interface Page<T> {
  data: T[]
  nextCursor: string | null
}

/**
 * Slice an already-fetched array into one page starting at `offset`, `limit`
 * rows. `all` must contain at least `offset + 1` rows for `nextCursor` to be
 * computed correctly when there is in fact more data than was fetched — see
 * each call site's comment for how much it over-fetches to make that true.
 */
export function paginate<T>(all: readonly T[], offset: number, limit: number): Page<T> {
  const data = all.slice(offset, offset + limit)
  const hasMore = offset + data.length < all.length
  return { data, nextCursor: hasMore ? encodeCursor(offset + data.length) : null }
}

/** Parse the shared `limit`/`cursor` query params. `limit` is clamped to
 *  `[1, maxLimit]`, defaulting to `defaultLimit` when absent or invalid. */
export function parsePageParams(
  url: URL,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const defaultLimit = opts.defaultLimit ?? 50
  const maxLimit = opts.maxLimit ?? 500
  let limit = defaultLimit
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) limit = Math.min(maxLimit, Math.max(1, parsed))
  }
  const offset = decodeCursor(url.searchParams.get("cursor"))
  return { limit, offset }
}
