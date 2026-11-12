// Map network-layer errors (HTTP status codes + known failure shapes) to
// human-readable, actionable strings. Technical detail is preserved on the
// error's `cause` field and structured properties — never shown as the primary
// user-facing message.
//
// Pattern mirrors src/lib/audio/ai-error.ts but for the general network layer
// (sync-worker, frontier, auth-worker). See AQU-281.
//
// This module runs outside React (plain fetch-helper code, no hooks), so it
// can't call useT(); it uses the standalone `t()` instead — see AQU-832.

import { t, tIfLocalized } from "../i18n/standalone"
import type { MessageKey } from "../i18n/messages/en"
import { resolveRoleName } from "../frontier/roles"

/**
 * AQU-1821: the closed vocabulary of nouns an error sentence may name.
 *
 * `context` used to be a free `string`, and every caller passed a bare English
 * word straight into `error.network.contextSuffix`'s `{context}`. The frame was
 * translated and the noun was not, so a Burmese 403 read
 * "ဤအရာကို ပြုလုပ်ရန် ခွင့်ပြုချက် မရှိပါ ဤteam အတွက်။" — a sentence that changes
 * language halfway through.
 *
 * A context is now an IDENTIFIER, not a word: each one names the message key
 * the catalogues own the noun under, so the noun is translated wherever the
 * frame is. `"team"` is a key of this map; `"teams"`, `"organization members"`
 * or any other English phrase is a compile error, which is what keeps a raw
 * noun from coming back (the acceptance criterion asks for enforcement rather
 * than convention).
 *
 * The three scope nouns reuse `org.access.scope.*`, already translated for the
 * access surfaces — so the reported Burmese case is now Burmese throughout,
 * not merely shortened.
 */
export const ERROR_CONTEXT_NOUNS = {
  org: "org.access.scope.org",
  team: "org.access.scope.team",
  project: "org.access.scope.project",
  user: "error.network.context.user",
  invite: "error.network.context.invite",
  changeset: "error.network.context.changeset",
} as const satisfies Record<string, MessageKey>

/** A noun `messageForStatus` / `toUserFacingError` may be asked to name. */
export type ErrorContext = keyof typeof ERROR_CONTEXT_NOUNS

/**
 * The rendered `{contextSuffix}` for `context` — `""` when there is none to
 * render.
 *
 * Empty whenever the caller named no object, and whenever this locale has not
 * translated EITHER half of the clause — the noun or the frame around it. The
 * five frame sentences read correctly on their own in all three cases. That is
 * the AQU-1821 rule: `tIfLocalized` returns null exactly where `t()` would fall
 * back to English, and half an English sentence is worse than a shorter fully
 * localized one. `locales.ts` (AQU-1306) rules out closing the gap with a
 * machine translation. Both halves are checked, not just the noun, so a locale
 * that translates the word but not the clause cannot leak " for this ___"
 * either.
 */
export function contextSuffixFor(context?: ErrorContext): string {
  if (!context) return ""
  const noun = tIfLocalized(ERROR_CONTEXT_NOUNS[context])
  if (noun === null) return ""
  return tIfLocalized("error.network.contextSuffix", { context: noun }) ?? ""
}

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
 * The optional `context` names what failed (e.g. `"project"`, `"invite"`) and is
 * woven into the message where useful to keep it actionable. It is one of
 * `ERROR_CONTEXT_NOUNS` — an identifier for a translated noun, never a word.
 */
export function messageForStatus(
  status: number,
  rawBody: string,
  context?: ErrorContext,
): UserFacingError {
  const contextSuffix = contextSuffixFor(context)
  const raw = rawBody.trim()

  switch (status) {
    case 400:
      return {
        message: t("error.network.badRequest", { contextSuffix }),
        raw,
        category: "unknown",
        status,
      }
    case 401:
      return {
        message: t("error.network.sessionExpired"),
        raw,
        category: "session-expired",
        status,
      }
    case 403:
      return {
        message:
          (isElevationRequiredBody(raw) ? t("error.network.elevationRequired") : null) ??
          roleRequiredMessage(raw) ??
          t("error.network.forbidden", { contextSuffix }),
        raw,
        category: "forbidden",
        status,
      }
    case 404:
      return {
        message: t("error.network.notFound", { contextSuffix }),
        raw,
        category: "not-found",
        status,
      }
    case 409:
      return {
        message: t("error.network.conflict", { contextSuffix }),
        raw,
        category: "conflict",
        status,
      }
    case 410:
      return {
        message: t("error.network.gone", { contextSuffix }),
        raw,
        category: "gone",
        status,
      }
    case 429:
      return {
        message: t("error.network.tooManyRequests"),
        raw,
        category: "server-error",
        status,
      }
    default:
      if (status >= 500) {
        return {
          message: t("error.network.serverError"),
          raw,
          category: "server-error",
          status,
        }
      }
      return {
        message: t("error.network.unknownStatus", { status }),
        raw,
        category: "unknown",
        status,
      }
  }
}

/** AQU-1322: part-2 step-up denials all carry an `error` starting "elevation required". */
export const ELEVATION_REQUIRED_PREFIX = "elevation required"

export function isElevationRequiredBody(raw: string): boolean {
  try {
    const body: unknown = JSON.parse(raw)
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null
    return typeof error === "string" && error.startsWith(ELEVATION_REQUIRED_PREFIX)
  } catch {
    return false
  }
}

// AQU-1352 §3.9 rule 2: badge labels reused from the access-model legend so the
// denial names the same origin the members table shows.
const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  override: "org.accessModelLegend.direct.label",
  group: "org.accessModelLegend.viaGroup.label",
  team: "org.accessModelLegend.viaGroup.label",
  org: "org.accessModelLegend.orgWide.label",
  creator: "org.accessModelLegend.creator.label",
  platform: "org.access.origin.platform",
}

/**
 * AQU-1352 §3.9 rule 2: when a 403 body carries `code: "role_required"`, say
 * who the caller is here, where that came from, and what is required — never
 * a numeric level. Returns null for any other body so the generic copy stands.
 */
export function roleRequiredMessage(raw: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!body || typeof body !== "object") return null
  const b = body as {
    code?: unknown
    required?: { roleLevel?: unknown }
    actual?: { roleLevel?: unknown; source?: unknown; scopePath?: unknown }
  }
  if (b.code !== "role_required" || typeof b.required?.roleLevel !== "number") return null
  const required = resolveRoleName(t, b.required.roleLevel)
  const actualLevel = b.actual?.roleLevel
  if (typeof actualLevel !== "number") return t("error.network.roleRequiredNoRole", { required })
  const role = resolveRoleName(t, actualLevel)
  const path = Array.isArray(b.actual?.scopePath)
    ? b.actual.scopePath.filter((s): s is string => typeof s === "string").join(" › ")
    : ""
  const sourceKey = typeof b.actual?.source === "string" ? SOURCE_LABEL_KEYS[b.actual.source] : undefined
  const origin = [sourceKey ? t(sourceKey) : "", path].filter(Boolean).join(" · ")
  return origin
    ? t("error.network.roleRequired", { role, origin, required })
    : t("error.network.roleRequiredNoOrigin", { role, required })
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
 * @param context Optional `ERROR_CONTEXT_NOUNS` key naming what was being
 *                fetched (e.g. `"project"`) — an identifier, not an English
 *                word; see AQU-1821.
 */
export function toUserFacingError(err: unknown, context?: ErrorContext): UserFacingError {
  if (isNetworkFailure(err)) {
    const raw = err instanceof Error ? err.message : String(err)
    return {
      message: t("error.network.offline"),
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
      const status = parseInt(match[1], 10)
      const body = (match[2] ?? "").trim()
      return messageForStatus(status, body || err.message, context)
    }
    // Raw message that isn't an HTTP pattern — pass through as-is.
    return { message: err.message, raw: err.message, category: "unknown" }
  }

  const raw = String(err)
  return { message: t("error.network.genericFailure"), raw, category: "unknown" }
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

  constructor(status: number, rawBody: string, context?: ErrorContext) {
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
