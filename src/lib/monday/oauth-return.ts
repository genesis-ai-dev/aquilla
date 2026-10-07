// Monday.com OAuth return: what the /oauth/callback tab tells the tab that
// opened it, and the plain-language failure messages both tabs show.
//
// Connect opens Monday in a NEW tab, and the original tab (org settings or the
// "Set up with AI" dialog) waits. The callback tab announces how it ended on a
// BroadcastChannel, so the waiting tab stops waiting on a failure too, not
// only when it regains focus after a success. A wait that hears nothing gives
// up after the state's own 10-minute lifetime.

import { useEffect, useRef } from "react"
import type { MessageKey } from "@/lib/i18n/messages/en"

/** Why a connection attempt failed. Server slugs plus the two the SPA adds. */
export type MondayConnectFailure =
  | "cancelled" // the user declined or cancelled in Monday
  | "expired" // state JWT failed to verify: older than 10 minutes, or reused/tampered
  | "token_exchange_failed" // Monday refused the code
  | "timeout" // the waiting tab heard nothing back
  | "failed" // anything else (missing params, network, internal)

export type MondayOAuthOutcome = { orgId: number | null } & (
  | { ok: true }
  | { ok: false; reason: MondayConnectFailure }
)

const CHANNEL = "aquilla-monday-oauth"

/** The state JWT lives 600s (routes/monday.ts); allow a little slack. */
export const MONDAY_OAUTH_WAIT_MS = 11 * 60 * 1000

/** Map anything the server or Monday sent back onto a known failure. */
export function toConnectFailure(reason: string | null | undefined): MondayConnectFailure {
  switch (reason) {
    case "access_denied":
    case "cancelled":
      return "cancelled"
    case "bad_state":
    case "expired":
      return "expired"
    case "token_exchange_failed":
    case "timeout":
      return reason
    default:
      return "failed"
  }
}

const FAILURE_KEYS: Record<MondayConnectFailure, MessageKey> = {
  cancelled: "settings.monday.failure.cancelled",
  expired: "settings.monday.failure.expired",
  token_exchange_failed: "settings.monday.failure.rejected",
  timeout: "settings.monday.failure.timeout",
  failed: "settings.monday.connectFailed",
}

export function connectFailureKey(reason: MondayConnectFailure): MessageKey {
  return FAILURE_KEYS[reason]
}

/**
 * Read `backTo` and `orgId` from the OAuth state WITHOUT verifying it — only
 * to know where "Back to Aquilla" goes when the exchange fails (an expired
 * state can't be verified, and Monday's cancel redirect carries no code). The
 * server verifies the state before trusting anything in it; here `backTo` is
 * kept only if it is an app path, so a forged state can't leave the SPA.
 */
export function peekMondayOAuthState(state: string | null): { backTo: string | null; orgId: number | null } {
  const none = { backTo: null, orgId: null }
  const payload = state?.split(".")[1]
  if (!payload) return none
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    const claims = JSON.parse(json) as { backTo?: unknown; orgId?: unknown }
    const backTo =
      typeof claims.backTo === "string" && claims.backTo.startsWith("/") && !claims.backTo.startsWith("//")
        ? claims.backTo
        : null
    const orgId = typeof claims.orgId === "number" && Number.isFinite(claims.orgId) ? claims.orgId : null
    return { backTo, orgId }
  } catch {
    return none
  }
}

/** Called by the callback tab once it knows how the round trip ended. */
export function announceMondayOAuthOutcome(outcome: MondayOAuthOutcome): void {
  if (typeof BroadcastChannel === "undefined") return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage(outcome)
  channel.close()
}

/**
 * While `active`, report how the other tab's connection attempt ended, or a
 * "timeout" failure once MONDAY_OAUTH_WAIT_MS passes with no word. Outcomes
 * for another org are ignored.
 */
export function useMondayOAuthOutcome(
  active: boolean,
  orgId: number | null,
  onOutcome: (outcome: MondayOAuthOutcome) => void,
): void {
  const onOutcomeRef = useRef(onOutcome)
  useEffect(() => {
    onOutcomeRef.current = onOutcome
  })
  useEffect(() => {
    if (!active) return
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL)
    if (channel) {
      channel.onmessage = (e: MessageEvent<MondayOAuthOutcome>) => {
        const outcome = e.data
        if (outcome.orgId != null && orgId != null && outcome.orgId !== orgId) return
        onOutcomeRef.current(outcome)
      }
    }
    const timer = window.setTimeout(
      () => onOutcomeRef.current({ ok: false, reason: "timeout", orgId }),
      MONDAY_OAUTH_WAIT_MS,
    )
    return () => {
      channel?.close()
      window.clearTimeout(timer)
    }
  }, [active, orgId])
}
