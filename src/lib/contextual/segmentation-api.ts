/**
 * Client for the per-file segmentation surface (auth-worker
 * routes/contextual.ts). Follows transport.ts conventions: AUTH_BASE +
 * fetchWithTimeout + `Authorization: Bearer <jwt>`, typed errors on non-OK.
 *
 *   GET /api/v2/projects/:projectId/contextual/segmentation?fileId=<id>
 *   PUT /api/v2/projects/:projectId/contextual/segmentation?fileId=<id>
 *
 * The GET returns the EFFECTIVE segmentation — resolved server-side through
 * the same code the autopilot run calls — so the preview a translator approves
 * is the segmentation the run will actually use. Nothing here recomputes
 * boundaries client-side; a second implementation would drift silently.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import { loadSession } from "@/lib/frontier/session-store"
import { ContextualApiError, ContextualAuthError } from "./transport"

export type SegmentationStrategy = "auto" | "fixed" | "explicit"

export interface SegmentBoundary {
  startCellId: string
  endCellId: string
  title?: string
  gist?: string
  depth?: number
}

export interface FileSegmentation {
  projectId: string
  fileId: string
  strategy: SegmentationStrategy
  fixedSize: number | null
  boundaries: SegmentBoundary[] | null
  note: string | null
  generatedBy: "human" | "model" | null
  modelId: string | null
  humanEdited: boolean
  staleSince: string | null
  staleReason: string | null
  version: number
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

/** One span in the preview. `label` is server-rendered ("MRK 1:1–1:8"). */
export interface SegmentationPreviewSpan {
  startCellId: string
  endCellId: string
  seedSource: string
  cellCount: number
  label: string
}

export interface SegmentationSnapshot {
  /** null when nobody has configured this file — which means 'auto'. */
  segmentation: FileSegmentation | null
  limits: { minSize: number; maxSize: number; maxBoundaries: number }
  effective: {
    seedSource: string
    spanCount: number
    cellCount: number
    /** A sample; `spanCount` is always the exact total. */
    spans: SegmentationPreviewSpan[]
    truncated: boolean
  }
  /** False when the backend does not serve this route (older deployment). */
  available: boolean
}

export interface SegmentationUpdate {
  strategy: SegmentationStrategy
  fixedSize?: number
  boundaries?: SegmentBoundary[]
  note?: string
}

const UNAVAILABLE: SegmentationSnapshot = {
  segmentation: null,
  limits: { minSize: 2, maxSize: 50, maxBoundaries: 2000 },
  effective: { seedSource: "chunk", spanCount: 0, cellCount: 0, spans: [], truncated: false },
  available: false,
}

async function requireJwt(): Promise<string> {
  const session = await loadSession()
  const jwt = session?.jwt
  if (!jwt) throw new ContextualAuthError()
  return jwt
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

function endpoint(projectId: string, fileId: string): string {
  return (
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}` +
    `/contextual/segmentation?fileId=${encodeURIComponent(fileId)}`
  )
}

async function throwFromResponse(res: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body?.error?.message) message = body.error.message
  } catch {
    /* non-JSON error body — keep the fallback */
  }
  throw new ContextualApiError(message, res.status)
}

export async function fetchSegmentation(
  projectId: string,
  fileId: string,
): Promise<SegmentationSnapshot> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(endpoint(projectId, fileId), { headers: authHeaders(jwt) })
  // Route not deployed for this environment: report unavailable so the dialog
  // explains itself instead of showing an error the user cannot act on.
  if (res.status === 404 || res.status === 501) return UNAVAILABLE
  if (!res.ok) return throwFromResponse(res, "Could not load this file's segmentation.")
  const body = (await res.json()) as Omit<SegmentationSnapshot, "available">
  return { ...body, available: true }
}

export async function saveSegmentation(
  projectId: string,
  fileId: string,
  update: SegmentationUpdate,
): Promise<FileSegmentation> {
  const jwt = await requireJwt()
  const res = await fetchWithTimeout(endpoint(projectId, fileId), {
    method: "PUT",
    headers: authHeaders(jwt),
    body: JSON.stringify(update),
  })
  if (!res.ok) return throwFromResponse(res, "Could not save this file's segmentation.")
  const body = (await res.json()) as { segmentation: FileSegmentation }
  return body.segmentation
}
