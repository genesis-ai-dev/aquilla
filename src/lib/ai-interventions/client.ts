// AI intervention audit trail (AQU-1656) — browser client for auth-worker
// /api/v2/projects/:projectId/ai-interventions.
//
// Recording never throws and is never awaited by a draft: the audit trail
// explains a draft, it must never be the reason one failed.

import { AUTH_BASE } from "@/lib/frontier/auth"

export type InterventionKind = "draft" | "smart_edit" | "harmonize"

export interface ModelCallMessage {
  role: string
  content: string
}

/** One model call and the cells it wrote. Mirrors recordSchema in
 *  auth-worker/src/routes/ai-interventions.ts. */
export interface ModelCallRecord {
  callId: string
  kind: InterventionKind
  mode: string
  model: string
  provider: string
  messages: readonly ModelCallMessage[]
  rawOutput: string
  cells: {
    interventionId: string
    fileId: string
    cellId: string
    basedOnEventId?: string | null
    output: string
    exampleCellIds: string[]
  }[]
}

/** Bound to a project, lane and session by the workspace. */
export type RecordModelCall = (call: ModelCallRecord) => void

/** Mirrors AiInterventionRow in auth-worker/src/routes/ai-interventions.ts. */
export interface AiIntervention {
  id: string
  callId: string
  lane: string
  fileId: string
  cellId: string
  kind: InterventionKind
  mode: string
  outcome: string
  model: string
  provider: string
  basedOnEventId: string | null
  output: string
  exampleCellIds: string[]
  hasTrace: boolean
  userId: string
  createdAt: number
}

export interface InterventionTrace {
  messages: ModelCallMessage[]
  output: string
}

const projectBase = (projectId: string) =>
  `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}`

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
})

export async function recordModelCall(
  projectId: string,
  lane: string,
  call: ModelCallRecord,
  token: string,
): Promise<void> {
  try {
    const res = await fetch(`${projectBase(projectId)}/ai-interventions`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...call, lane }),
    })
    if (!res.ok) console.warn(`[ai-interventions] record failed: ${res.status}`)
  } catch (err) {
    console.warn("[ai-interventions] record failed:", err)
  }
}

export async function fetchCellInterventions(
  projectId: string,
  cellId: string,
  lane: string,
  token: string,
  signal?: AbortSignal,
): Promise<AiIntervention[]> {
  const res = await fetch(
    `${projectBase(projectId)}/cells/${encodeURIComponent(cellId)}/ai-interventions?lane=${encodeURIComponent(lane)}`,
    { headers: authHeaders(token), signal },
  )
  if (!res.ok) throw new Error(`Could not load AI history (${res.status})`)
  const body = (await res.json()) as { interventions?: AiIntervention[] }
  return body.interventions ?? []
}

/** null = the prompt was not stored for this intervention. */
export async function fetchInterventionTrace(
  projectId: string,
  interventionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<InterventionTrace | null> {
  const res = await fetch(
    `${projectBase(projectId)}/ai-interventions/${encodeURIComponent(interventionId)}/trace`,
    { headers: authHeaders(token), signal },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not load the prompt (${res.status})`)
  return (await res.json()) as InterventionTrace
}

/** True when the cell's current draft is the one this intervention wrote. */
export function isCurrentIntervention(
  intervention: Pick<AiIntervention, "id">,
  currentDraftInterventionId: string | undefined,
): boolean {
  return currentDraftInterventionId === intervention.id
}
