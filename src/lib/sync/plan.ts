// AQU-1092…1098: the project's plan — one row per planning unit, with the
// progress the board draws and the target date / Done mark a manager sets.
//
// Talks to the sync worker (not the identity API) and therefore needs a
// project-scoped SYNC token, the same one the overview already mints to read
// its file list.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"

const PLAN_TIMEOUT_MS = 15_000

export class PlanRequestError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`plan request failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.name = "PlanRequestError"
    this.status = status
    this.body = body
  }
}

/** One planning unit: a Bible book inside a Scripture file, or a whole file. */
export interface PlanUnit {
  fileId: string
  fileName: string
  fileRole: string | null
  fileKind: string | null
  /** '' for a file-grain unit; a Bible book code for a sub-file one. */
  sectionKey: string
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
  /**
   * AQU-1278: what the two audio counts are out of, when that is not
   * `totalCount` — a dubbing project's takes hang off a hidden cue sheet with
   * a cell count of its own. Null (and absent, from a worker that predates
   * this) means audio shares the text denominator.
   */
  audioTotalCount?: number | null
  lastEditAt: number | null
  targetDate: string | null
  doneAt: number | null
  doneBy: string | null
  updatedAt: number | null
  updatedBy: string | null
}

export interface PlanResponse {
  projectId: string
  lane: string
  validationCount: number
  revision: number
  units: PlanUnit[]
}

/** The half of a unit a manager can change. Omit a field to leave it alone. */
export interface PlanUnitPatch {
  fileId: string
  sectionKey: string
  /** A 'YYYY-MM-DD' date, or null to clear it. */
  targetDate?: string | null
  done?: boolean
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new PlanRequestError(res.status, await res.text().catch(() => ""))
  return (await res.json()) as T
}

/** GET the plan for one lane. Pass '' for the default lane. */
export async function fetchProjectPlan(
  projectId: string,
  token: string,
  lane = "",
): Promise<PlanResponse> {
  const base = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/plan`
  const url = lane ? `${base}?lane=${encodeURIComponent(lane)}` : base
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: timeoutSignal(PLAN_TIMEOUT_MS),
  })
  return readJson<PlanResponse>(res)
}

/**
 * Patch one unit's plan. Returns the unit as the server now sees it, including
 * its progress, so a caller can replace its optimistic copy with the truth.
 */
export async function setPlanUnit(
  projectId: string,
  token: string,
  patch: PlanUnitPatch,
  lane = "",
): Promise<PlanUnit> {
  const base = `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/plan`
  const url = lane ? `${base}?lane=${encodeURIComponent(lane)}` : base
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal: timeoutSignal(PLAN_TIMEOUT_MS),
  })
  const body = await readJson<{ unit: PlanUnit }>(res)
  return body.unit
}
