// AQU-538 slice 4: opt-in sibling-project merge — identity-side service call.
//
// Mints a short-lived service sync-token (role 500) and POSTs to the
// sync-worker's fold endpoint. Copies the triggerLinkSeedSync claims/env
// pattern in services/source-linking.ts EXACTLY (same SyncTokenClaims shape,
// same SYNC_WORKER_URL + SYNC_SECRET_KEY env), but — unlike the best-effort
// seed trigger — the caller MUST see the fold report and MUST NOT proceed with
// archiving the donor if the fold failed, so this returns a structured
// success/failure instead of a bare boolean.

import { sign } from "hono/jwt"
import type { Env, RoleResolution } from "../types"

export interface MergeSkip {
  cellId: string
  preview: string
}

export interface MergeSiblingFoldResult {
  merged: number
  skipped: MergeSkip[]
  lane: string
  /** AQU-1602: the donor lane that was folded, by `lanes.id`. */
  donorLaneId?: string
  /** AQU-1602: the host lane the rows landed in, by `lanes.id`. */
  hostLaneId?: string | null
}

/** One of the donor lanes a refused fold offers instead (AQU-1602). */
export interface DonorLaneOption {
  id: string
  name: string
}

export type TriggerMergeResult =
  | { ok: true; result: MergeSiblingFoldResult }
  | { ok: false; status: number; error: string; donorLanes?: DonorLaneOption[] }

export async function triggerMergeSiblingFold(
  env: Env,
  args: {
    hostProjectId: string
    donorProjectId: string
    lane: string
    /** AQU-1602: the donor lane to fold, by `lanes.id`. Omitted lets the fold
     *  take the donor's single active lane. */
    donorLaneId?: string
    /** Who is running the merge, and the path their role on the DONOR resolved
     *  through — the sync worker re-checks that role itself (see below). */
    caller: { userId: number; donorRoleSource: RoleResolution["source"] }
  },
): Promise<TriggerMergeResult> {
  if (!env.SYNC_WORKER_URL || !env.SYNC_SECRET_KEY) {
    return { ok: false, status: 500, error: "sync worker not configured" }
  }

  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    {
      // AQU-1550: the person running the merge, not a placeholder. The token
      // only proves host access, so the fold endpoint re-checks the caller's
      // LIVE role on the donor (pen test 2026-09-29) — which it can only do
      // for a real user id. With `userId: 0` it refused every merge.
      userId: args.caller.userId,
      username: "merge-sibling",
      projectId: args.hostProjectId,
      // Not checked by verifyTokenForProject (project-scoped, not file-scoped)
      // — placeholder to satisfy the SyncTokenClaims shape.
      fileId: "__merge_sibling__",
      role: 500,
      // How the caller's DONOR role resolved. The donor check is the one thing
      // the fold endpoint reads this for: "platform" (an ADMIN_EMAILS operator,
      // who has no membership row to re-check) is its documented exemption;
      // every other source is verified against the donor's live grants.
      src: args.caller.donorRoleSource,
      aud: "sync",
      iat: now,
      exp: now + 300,
    },
    env.SYNC_SECRET_KEY,
    "HS256",
  )

  let res: Response
  try {
    res = await fetch(
      `${env.SYNC_WORKER_URL.replace(/\/$/, "")}/api/v1/projects/${encodeURIComponent(args.hostProjectId)}/merge-sibling`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          donorProjectId: args.donorProjectId,
          lane: args.lane,
          ...(args.donorLaneId ? { donorLaneId: args.donorLaneId } : {}),
        }),
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 502, error: `merge fold request failed: ${message}` }
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "")
    // AQU-1602: the fold refuses an unchoosable donor lane with a 400 and the
    // candidates. That is the caller's to fix, so pass it through as a 400
    // rather than reporting a bad gateway — nothing was written either way.
    if (res.status === 400) {
      const parsed = parseRefusal(bodyText)
      if (parsed) return { ok: false, status: 400, ...parsed }
    }
    return {
      ok: false,
      status: 502,
      error: `merge fold failed (${res.status}): ${bodyText}`,
    }
  }

  const result = (await res.json().catch(() => null)) as MergeSiblingFoldResult | null
  if (!result || typeof result.merged !== "number") {
    return { ok: false, status: 502, error: "merge fold returned an unexpected response" }
  }
  return { ok: true, result }
}

/** The fold's 400 body, when it is the structured donor-lane refusal. */
function parseRefusal(
  bodyText: string,
): { error: string; donorLanes?: DonorLaneOption[] } | null {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return null
  }
  if (!body || typeof body !== "object") return null
  const { error, donorLanes } = body as { error?: unknown; donorLanes?: unknown }
  if (typeof error !== "string") return null
  const lanes = Array.isArray(donorLanes)
    ? donorLanes.flatMap((lane) => {
        const row = lane as { id?: unknown; name?: unknown }
        return typeof row?.id === "string" && typeof row?.name === "string"
          ? [{ id: row.id, name: row.name }]
          : []
      })
    : undefined
  return lanes && lanes.length > 0 ? { error, donorLanes: lanes } : { error }
}
