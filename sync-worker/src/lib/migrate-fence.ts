// AQU-1005 / AQU-1007: identification fence for the bulk-migration surface.
//
// The Aug 25–26 sync-delay storms were partly caused by /migrate/* traffic
// from an UNIDENTIFIED runner (every scheduled GitHub workflow was dead), and
// successful ingest batches previously left no log trail at all. Every
// /migrate/* request must now carry `x-migrate-runner: <who/what>`:
//   - present → the run proceeds and is logged (runner, path, method), giving
//     bulk ingests the audit trail they never had;
//   - missing → 503, plus a log of ip / user-agent / colo — which locates any
//     legacy automation still holding SYNC_SECRET_KEY without rotating it.
//
// This is identification + intentionality, NOT authentication — the routes
// behind the fence still enforce the service credential themselves.

import { shipLog, type PosthogLogEnv } from "../posthog-logs"

export const MIGRATE_RUNNER_HEADER = "x-migrate-runner"

/** 503 body — tells a legitimate operator exactly how to proceed. */
const FENCE_MESSAGE =
  `migration surface is fenced (AQU-1005): send "${MIGRATE_RUNNER_HEADER}: <who or what is running this>" ` +
  `so the run is attributable in the audit log, and schedule bulk ingests away from live user sessions`

/**
 * Returns a 503 for /migrate/* requests missing the runner header, null
 * otherwise (including for non-migrate paths). Ships an audit log for every
 * /migrate/* attempt, allowed or blocked.
 */
export function migrateFenceResponse(
  request: Request,
  env: PosthogLogEnv,
  ctx: ExecutionContext,
): Response | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/migrate/")) return null

  const runner = request.headers.get(MIGRATE_RUNNER_HEADER)
  const attrs = {
    "http.method": request.method,
    "http.path": url.pathname,
    "migrate.runner": runner ?? undefined,
    "net.peer.ip": request.headers.get("cf-connecting-ip") ?? undefined,
    "http.user_agent": request.headers.get("user-agent") ?? undefined,
    "cf.colo": (request as { cf?: { colo?: string } }).cf?.colo,
  }

  if (runner) {
    ctx.waitUntil(
      shipLog(
        env,
        "aquilla-sync-worker",
        "info",
        `migrate run: ${request.method} ${url.pathname} by ${runner}`,
        attrs,
      ),
    )
    return null
  }

  ctx.waitUntil(
    shipLog(
      env,
      "aquilla-sync-worker",
      "warn",
      `migrate blocked (no ${MIGRATE_RUNNER_HEADER}): ${request.method} ${url.pathname}`,
      attrs,
    ),
  )
  return new Response(FENCE_MESSAGE, { status: 503 })
}
