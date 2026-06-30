// Map network-layer errors (HTTP status codes + known failure shapes) to
// human-readable, actionable strings. Technical detail is preserved on the
// error's `cause` field and structured properties — never shown as the primary
// user-facing message.
//
// Pattern mirrors src/lib/audio/ai-error.ts but for the general network layer
// (sync-worker, frontier, auth-worker). See FRO-281.

export type NetworkErrorCategory =
  | "forbidden"
  | "not-found"
  | "session-expired"
  | "offline"
  | "server-error"
  | "conflict"
  | "gone"
  | "unknown"

export interface UserFacingError {
  /** Short heading for toasts / inline errors. Plain English, no HTTP jargon. */
  message: string
  /** The original raw message, preserved for DevTools / error.cause. */
  raw: string
  category: NetworkErrorCategory
  /** HTTP status, if the error came from a response. */
  status?: number
}

/**
 * Map an HTTP status code to a human-readable message.
 *
 * The optional `context` string (e.g. "project", "member") is woven into the
 * message where useful to keep it actionable. Callers may pass a short noun.
 */
export function messageForStatus(
  status: number,
  rawBody: string,
  context?: string,
): UserFacingError {
  const ctx = context ? ` for this ${context}` : ""
  const raw = rawBody.trim()

  switch (status) {
    case 400:
      return {
        message: `The request was invalid${ctx}. Check your input and try again.`,
        raw,
        category: "unknown",
        status,
      }
    case 401:
      return {
        message: "Your session expired — sign in again.",
        raw,
        category: "session-expired",
        status,
      }
    case 403:
      return {
        message: `You don't have permission to do that${ctx}.`,
        raw,
        category: "forbidden",
        status,
      }
    case 404:
      return {
        message: `That item no longer exists${ctx}.`,
        raw,
        category: "not-found",
        status,
      }
    case 409:
      return {
        message: `A conflict occurred${ctx} — please refresh and try again.`,
        raw,
        category: "conflict",
        status,
      }
    case 410:
      return {
        message: `That item has been permanently removed${ctx}.`,
        raw,
        category: "gone",
        status,
      }
    case 429:
      return {
        message: "Too many requests — please wait a moment and try again.",
        raw,
        category: "server-error",
        status,
      }
    default:
      if (status >= 500) {
        return {
          message: "Something went wrong on the server. Please try again in a moment.",
          raw,
          category: "server-error",
          status,
        }
      }
      return {
        message: `The request failed (${status}). Please try again.`,
        raw,
        category: "unknown",
        status,
      }
  }
}

/**
 * Detect offline / network-level failures (before an HTTP response is
 * received). Returns true for TypeError "Failed to fetch" etc.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message.toLowerCase()
  return (
    m.includes("failed to fetch") ||
    m.includes("fetch failed") ||
    m.includes("network error") ||
    m.includes("err_internet") ||
    m.includes("err_network") ||
    m.includes("offline")
  )
}

/**
 * Convert any caught error into a UserFacingError. Network failures map to the
 * offline message; HTTP-status errors (thrown by our fetch helpers) are parsed
 * by status; everything else falls through to "unknown".
 *
 * @param err     The raw caught value.
 * @param context Optional noun describing what was being fetched (e.g. "project").
 */
export function toUserFacingError(err: unknown, context?: string): UserFacingError {
  if (isNetworkFailure(err)) {
    const raw = err instanceof Error ? err.message : String(err)
    return {
      message: "You're offline — changes will sync when you reconnect.",
      raw,
      category: "offline",
    }
  }

  if (err instanceof UserError) {
    return { message: err.message, raw: err.raw, category: err.category, status: err.status }
  }

  if (err instanceof Error) {
    // Parse "... failed: HTTP 403 — <body>" patterns emitted by our fetch helpers.
    const match = err.message.match(/HTTP (\d{3})(?:\s*[—-]\s*(.*))?$/s)
    if (match) {
      const status = parseInt(match[1]!, 10)
      const body = (match[2] ?? "").trim()
      return messageForStatus(status, body || err.message, context)
    }
    // Raw message that isn't an HTTP pattern — pass through as-is.
    return { message: err.message, raw: err.message, category: "unknown" }
  }

  const raw = String(err)
  return { message: "Something went wrong. Please try again.", raw, category: "unknown" }
}

/**
 * Structured error class for our fetch helpers to throw. Carries the mapped
 * human message as `.message` and raw technical detail as `.raw` + `.cause`.
 *
 * Usage in fetch helpers:
 *   throw new UserError(res.status, bodyText, context)
 */
export class UserError extends Error {
  readonly category: NetworkErrorCategory
  readonly status: number
  readonly raw: string

  constructor(status: number, rawBody: string, context?: string) {
    const mapped = messageForStatus(status, rawBody, context)
    super(mapped.message)
    this.name = "UserError"
    this.category = mapped.category
    this.status = status
    this.raw = rawBody.trim()
    // Preserve raw detail so DevTools can drill in.
    this.cause = `HTTP ${status}${rawBody.trim() ? ` — ${rawBody.trim().slice(0, 400)}` : ""}`
  }
}
