// Map network-layer errors (HTTP status codes + known failure shapes) to
// human-readable, actionable strings. Technical detail is preserved on the
// error's `cause` field and structured properties — never shown as the primary
// user-facing message.
//
// Pattern mirrors src/lib/audio/ai-error.ts but for the general network layer
// (sync-worker, frontier, auth-worker). See AQU-281.
//
// This module runs outside React (plain fetch-helper code, no hooks), so it
// can't call useT(). `t()` below resolves the active locale straight from
// storage (the same source I18nProvider seeds its initial state from) and
// falls back to English exactly like the provider-less FALLBACK_CONTEXT in
// I18nProvider.tsx — see AQU-832.

import { CATALOGS } from "../i18n/messages"
import type { MessageKey } from "../i18n/messages/en"
import { DEFAULT_LOCALE, normalizeLocale } from "../i18n/locales"
import { readStoredLocale } from "../i18n/store"
import { translate, type TVars } from "../i18n/translate"

function t(key: MessageKey, vars?: TVars): string {
  const locale = normalizeLocale(readStoredLocale())
  return translate(CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE], key, vars, locale)
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
 * The optional `context` string (e.g. "project", "member") is woven into the
 * message where useful to keep it actionable. Callers may pass a short noun.
 */
export function messageForStatus(
  status: number,
  rawBody: string,
  context?: string,
): UserFacingError {
  const contextSuffix = context ? t("error.network.contextSuffix", { context }) : ""
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
        message: t("error.network.forbidden", { contextSuffix }),
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
      const status = parseInt(match[1]!, 10)
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
