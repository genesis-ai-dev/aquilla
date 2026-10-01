/**
 * AQU-307: "Report a problem" — payload assembly + PostHog submission.
 *
 * AQU-1028: PostHog is now the SECONDARY signal. The report itself is delivered
 * by `lib/feedback.ts` → auth-worker `/api/v2/feedback` → the team inbox, so it
 * lands whether or not the user consented to analytics. This module still
 * mirrors the report into PostHog when consent is on (so a report is greppable
 * alongside the session replay it belongs to) and still builds the plain-text
 * copy fallback.
 *
 * All PostHog calls are already consent-gated at the posthog.ts module level
 * (opt_out_capturing_by_default=true). This module just assembles the payload
 * and calls posthog.capture(). If analytics are off, the caller must surface
 * that to the user — this module does NOT silently no-op.
 */

import posthog from "@/lib/posthog"
import { isAnalyticsEnabled } from "@/lib/analytics-consent"

export const REPORT_PROBLEM_EVENT = "report problem submitted"

export interface ReportContext {
  /** Current window.location.pathname */
  route: string
  /** Active project ID (if any) */
  projectId?: string
  /** Active file ID (if any) */
  fileId?: string
}

export interface ReportProblemPayload {
  description: string
  context: ReportContext
  /** posthog-js session replay URL, if available */
  sessionReplayUrl?: string | null
  /** AQU-1028: whether a screenshot rode along to the team inbox. The image
   *  itself never goes to PostHog — an event property cannot carry one — but
   *  knowing a report has a picture attached is what makes the analytics row
   *  worth opening. */
  hasScreenshot?: boolean
}

/**
 * Capture the report event. Returns whether the event was actually sent.
 * (Returns false when consent is off — the caller shows the copy-fallback.)
 */
export function captureReportProblem(payload: ReportProblemPayload): boolean {
  if (!isAnalyticsEnabled()) return false

  const replayUrl =
    payload.sessionReplayUrl ?? getSessionReplayUrl()

  posthog.capture(REPORT_PROBLEM_EVENT, {
    description: payload.description,
    route: payload.context.route,
    project_id: payload.context.projectId ?? null,
    file_id: payload.context.fileId ?? null,
    session_replay_url: replayUrl ?? null,
    has_screenshot: payload.hasScreenshot === true,
  })
  return true
}

/**
 * Try to get the current session replay URL from posthog-js.
 * posthog.get_session_replay_url() exists in posthog-js ≥ 1.87.
 * We guard defensively because the method is absent when recording is disabled.
 */
export function getSessionReplayUrl(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (posthog as any).get_session_replay_url
    if (typeof fn !== "function") return null
    return (fn as () => string | null).call(posthog) ?? null
  } catch {
    return null
  }
}

/**
 * Build a plain-text report string suitable for copying when analytics are off.
 */
export function buildReportText(payload: ReportProblemPayload): string {
  const lines = [
    `Route: ${payload.context.route}`,
    payload.context.projectId ? `Project: ${payload.context.projectId}` : null,
    payload.context.fileId ? `File: ${payload.context.fileId}` : null,
    payload.hasScreenshot ? `Screenshot: attached (sent to the team, not included here)` : null,
    `---`,
    payload.description,
  ].filter(Boolean)
  return lines.join("\n")
}
