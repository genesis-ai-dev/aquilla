/**
 * changeset-api.ts — typed fetch client for the staged-changeset review flow
 * (AQU-926, docs/COMMAND-REGISTRY.md §5).
 *
 * Two backends, one client:
 * - auth-worker `/api/v2/changesets/:id/{approval,approve,reject}` — the
 *   human-approval surface (session Bearer JWT). Shapes mirror
 *   auth-worker/src/routes/changeset-approvals.ts.
 * - sync-worker `/api/v1/changesets/:projectId` (list) and
 *   `/api/v1/changesets/:projectId/:changesetId/{commit,discard}` — the
 *   session surface (short-lived sync token, minted with the established
 *   `__project__` sentinel — same convention as useComments / outbox-flush /
 *   archive.triggerLinkSync). Responses mirror the external
 *   `changesetToResponse` (sync-worker/src/external/store.ts).
 *
 * Mirrors src/lib/agent/memory-api.ts conventions: AUTH_BASE +
 * fetchWithTimeout + Bearer auth, thrown Error subclasses on non-OK. One
 * deliberate deviation: `ChangesetApiError.message` carries the SERVER's
 * error.message verbatim when present (falling back to a generic line),
 * because these messages are curated human-readable strings the cards render
 * inline ("changeset has expired", "digest mismatch — …").
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import { fetchSyncToken, SyncTokenError } from "@/lib/sync/sync-token"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type {
  ChangesetChanges,
  ChangesetImportPreview,
} from "@/components/changesets/ChangeList"

// ── Types (approval GET — changeset-approvals.ts response construction) ─────

/** The changeset status vocabulary, mirroring sync-worker
 *  `CHANGESET_STATUSES` (src/external/store.ts) plus AQU-CMDREG-P1's
 *  `superseded` (docs/COMMAND-REGISTRY-P1.md §1).
 *
 *  `superseded` is the HEALTHY end-state: the plan's outcome already exists
 *  because a person did the work by hand. It is never folded into `stale`
 *  (preconditions drifted some other way) or `expired` (nobody acted) — those
 *  count problems, this one doesn't. */
export const CHANGESET_STATUSES = [
  "staged",
  "committing",
  "committed",
  "discarded",
  "stale",
  "superseded",
  "expired",
] as const

export type ChangesetStatusName = (typeof CHANGESET_STATUSES)[number]

/** Server statuses are cast, not parsed, so display helpers still take a plain
 *  `string` — an older/newer worker naming a status we don't know must render
 *  as unknown-but-pending, never crash a review card. */
export function isChangesetStatusName(value: string): value is ChangesetStatusName {
  return (CHANGESET_STATUSES as readonly string[]).includes(value)
}

/** One summary entry per staged event kind (COMMAND-REGISTRY §2 EmitEvents).
 *  `testimony: true` marks kinds that need per-item human confirmation. */
export interface ChangesetSummaryEvent {
  kind: string
  count: number
  testimony?: boolean
}

export interface ChangesetApprovalSummary {
  warnings?: { message: string }[]
  /** UpdateProjectSettings/PatchSettings: per-key truncated previews. */
  settingsChanges?: Record<string, string>
  /** EmitEvents changesets: per-kind counts with testimony marks. */
  events?: ChangesetSummaryEvent[]
  /** AQU-1228 Living Memory writes: the entry path being written or retired
   *  plus a one-line preview of its content — the approval page renders these
   *  explicitly, because approving IS the memory review. */
  memoryWrites?: { path: string; action: string; preview: string }[]
  /** InsertCell/DeleteCell/SplitCell: the one structural effect line — which
   *  command, the file, and how many rows move (AQU-1234). */
  structure?: ChangesetSummaryStructure
  [key: string]: unknown
}

/** Server-computed effect line for a cell-structure changeset. */
export interface ChangesetSummaryStructure {
  command: 'InsertCell' | 'DeleteCell' | 'SplitCell'
  fileId: string
  cellsAdded: number
  cellsRemoved: number
  cellsReanchored: number
  targetsRemoved: number
  targetsRewritten: number
}

/** GET /api/v2/changesets/:id/approval response (auth-worker
 *  changeset-approvals.ts — the same payload the /approve/:id page renders). */
export interface ChangesetApproval {
  changesetId: string
  projectId: string
  projectName: string | null
  status: ChangesetStatusName
  autonomyMode: string
  /** Who the changeset is ROUTED to (COMMAND-REGISTRY-P1 §2.2). Absent on
   *  older servers, `null` when unassigned. Routing never resolves anything:
   *  an assigned changeset is still `staged` and still needs a human. */
  assignedToUserId?: string | null
  summary: ChangesetApprovalSummary
  /** Per-cell before/after detail (SetTranslation commands), capped server-side. */
  changes?: ChangesetChanges
  /** Sample cells for a PlanImport command. */
  importPreview?: ChangesetImportPreview
  digest: string
  createdAt: string
  expiresAt: string
}

/** POST /:id/approve response — a one-time confirmation the commit consumes. */
export interface ChangesetApproveResult {
  confirmationId: string
  expiresAt: string
  message?: string
}

/** POST /:id/reject response. */
export interface ChangesetRejectResult {
  changesetId: string
  status: ChangesetStatusName
}

/** Execution receipt recorded on commit (sync-worker external types —
 *  ChangesetReceipt). Receipt-only lifecycle commands stamp a different shape;
 *  callers should treat the count fields as optional-when-absent. */
export interface ChangesetCommitReceipt {
  eventIds?: string[]
  appliedCount?: number
  staleCount?: number
  warnings?: { code: string; fileId: string; cellId: string; message: string }[]
  committedAt?: string
  fileId?: string
  [key: string]: unknown
}

/** Changeset status payload — mirrors the external `changesetToResponse`
 *  (sync-worker/src/external/store.ts). After commit: status 'committed'
 *  plus the receipt. */
export interface ChangesetStatus {
  id: string
  projectId: string
  createdByUserId: string
  credentialId: string
  autonomyMode: string
  status: ChangesetStatusName
  commands: unknown
  preconditions: unknown
  summary: ChangesetApprovalSummary
  digest: string
  receipt: ChangesetCommitReceipt | null
  confirmationId: string | null
  createdAt: string
  expiresAt: string
  committedAt: string | null
}

// ── Typed errors ────────────────────────────────────────────────────────────

/** Non-OK response. `message` is the server's `error.message` when the body
 *  carried one (curated, render-safe strings), else a generic fallback;
 *  `code` is the stable machine code shared by both workers' error envelopes
 *  (auth-worker changeset-approvals.ts / sync-worker external/errors.ts). */
export class ChangesetApiError extends Error {
  public status: number
  public code?: string
  public details?: unknown
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** 409 `validation_failed` + details.code `digest_mismatch` — the digest sent
 *  to approve doesn't match the staged plan (it changed since the card
 *  loaded). The fix is always a refetch, so it gets its own type. */
export class DigestMismatchError extends ChangesetApiError {
  constructor(message: string, details?: unknown) {
    super(message, 409, "validation_failed", details)
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: { code?: string } & Record<string, unknown> }
}

async function parseErrorAndThrow(res: Response, fallback: string): Promise<never> {
  let body: ErrorEnvelope | null = null
  try {
    body = (await res.json()) as ErrorEnvelope
  } catch {
    // non-JSON error body — fall through to the generic error
  }
  const code = body?.error?.code
  const details = body?.error?.details
  const message = body?.error?.message ?? `${fallback} (HTTP ${res.status})`
  if (res.status === 409 && details?.code === "digest_mismatch") {
    throw new DigestMismatchError(message, details)
  }
  throw new ChangesetApiError(message, res.status, code, details)
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

// ── Approval surface (auth-worker, session JWT) ─────────────────────────────

/** GET /api/v2/changesets/:id/approval — load a changeset for review. Only the
 *  human who owns the staging credential may read it (server-enforced). */
export async function fetchChangesetApproval(
  jwt: string,
  changesetId: string,
): Promise<ChangesetApproval> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/changesets/${encodeURIComponent(changesetId)}/approval`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) return parseErrorAndThrow(res, "load changeset approval failed")
  return (await res.json()) as ChangesetApproval
}

/** POST /api/v2/changesets/:id/approve — mint the one-time confirmation.
 *  `digest` MUST be the one the approval GET returned, never one a frame
 *  carried, so what's approved is provably what the server staged. */
export async function approveChangeset(
  jwt: string,
  changesetId: string,
  digest: string,
): Promise<ChangesetApproveResult> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/changesets/${encodeURIComponent(changesetId)}/approve`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify({ digest }) },
  )
  if (!res.ok) return parseErrorAndThrow(res, "approve changeset failed")
  return (await res.json()) as ChangesetApproveResult
}

/** POST /api/v2/changesets/:id/reject — discard a staged changeset. */
export async function rejectChangeset(
  jwt: string,
  changesetId: string,
): Promise<ChangesetRejectResult> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/changesets/${encodeURIComponent(changesetId)}/reject`,
    { method: "POST", headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) return parseErrorAndThrow(res, "reject changeset failed")
  return (await res.json()) as ChangesetRejectResult
}

// ── Commit surface (sync-worker, session sync token) ────────────────────────

/** Project-scoped sync-token sentinel — the established fileId for
 *  project-level, non-file-scoped calls (useComments / outbox-flush /
 *  archive.triggerLinkSync all use it; the server ignores fileId here). */
const PROJECT_SENTINEL_FILE_ID = "__project__"

/** Mint a project-scoped sync token, folding mint failures into the client's
 *  single error type so callers surface one shape. */
async function mintProjectSyncToken(jwt: string, projectId: string): Promise<string> {
  try {
    const { token } = await fetchSyncToken(jwt, projectId, PROJECT_SENTINEL_FILE_ID)
    return token
  } catch (err) {
    if (err instanceof SyncTokenError) {
      throw new ChangesetApiError(
        "Couldn't authorize with the sync service. Refresh and try again.",
        err.status,
      )
    }
    throw err
  }
}

/** The session routes respond with the changeset status payload; tolerate both
 *  the bare `changesetToResponse` shape and the external routes' `{ changeset }`
 *  wrapper (sync-worker/src/external/changesets-route.ts wraps, the contract
 *  doc says "changesetToResponse shape" — accept either until the worker
 *  stream settles the envelope). */
function unwrapChangeset(body: ChangesetStatus | { changeset: ChangesetStatus }): ChangesetStatus {
  return "changeset" in body ? body.changeset : body
}

/** POST {sync}/api/v1/changesets/:projectId/:changesetId/commit — apply an
 *  approved changeset server-side. Requires the approve confirmation to have
 *  been minted first (428 `confirmation_required` otherwise). Returns the
 *  committed status payload including the execution receipt. */
export async function commitChangeset(
  jwt: string,
  projectId: string,
  changesetId: string,
): Promise<ChangesetStatus> {
  const token = await mintProjectSyncToken(jwt, projectId)
  const res = await fetchWithTimeout(
    `${syncWorkerHttpOrigin()}/api/v1/changesets/${encodeURIComponent(projectId)}/${encodeURIComponent(changesetId)}/commit`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return parseErrorAndThrow(res, "commit changeset failed")
  return unwrapChangeset(
    (await res.json()) as ChangesetStatus | { changeset: ChangesetStatus },
  )
}

/** POST {sync}/api/v1/changesets/:projectId/:changesetId/discard. */
export async function discardChangeset(
  jwt: string,
  projectId: string,
  changesetId: string,
): Promise<ChangesetStatus> {
  const token = await mintProjectSyncToken(jwt, projectId)
  const res = await fetchWithTimeout(
    `${syncWorkerHttpOrigin()}/api/v1/changesets/${encodeURIComponent(projectId)}/${encodeURIComponent(changesetId)}/discard`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return parseErrorAndThrow(res, "discard changeset failed")
  return unwrapChangeset(
    (await res.json()) as ChangesetStatus | { changeset: ChangesetStatus },
  )
}

// ── Pending inbox (sync-worker list route, COMMAND-REGISTRY-P1 §3.3) ────────

/** How many staged changesets the server surfaces by default; the rest come
 *  back as `heldCount`, never as rows. Mirrored here so a list surface can say
 *  what it is showing without re-deriving the cap. */
export const SURFACED_CAP = 3

/** One row of the list route — `changesetToResponse` plus the approval URL the
 *  route appends (sync-worker/src/external/session-routes.ts handleList). */
export interface ChangesetListItem extends ChangesetStatus {
  approvalUrl: string
}

/** GET /api/v1/changesets/:projectId response. `heldCount` is the number of
 *  staged changesets ranked BELOW the surfaced ones — still `staged`, held
 *  rather than closed, so a later supersession sweep can still close them.
 *  `surfacedCap` is the server's cap for this view, echoed so a list can say
 *  what it is showing without assuming the constant below. */
export interface ChangesetListPage {
  changesets: ChangesetListItem[]
  heldCount: number
  surfacedCap: number
}

/** List a project's changesets. The server ranks them by blast radius and, in
 *  the default view, surfaces only `SURFACED_CAP` of them; `limit` pages
 *  further down that ranking. `heldCount` always reports the staged rows the
 *  returned page still leaves out. */
export async function listProjectChangesets(
  jwt: string,
  projectId: string,
  opts: { status?: ChangesetStatusName; limit?: number } = {},
): Promise<ChangesetListPage> {
  const token = await mintProjectSyncToken(jwt, projectId)
  const query = new URLSearchParams()
  if (opts.status) query.set("status", opts.status)
  if (opts.limit !== undefined) query.set("limit", String(opts.limit))
  const qs = query.toString()
  const res = await fetchWithTimeout(
    `${syncWorkerHttpOrigin()}/api/v1/changesets/${encodeURIComponent(projectId)}${qs ? `?${qs}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return parseErrorAndThrow(res, "list changesets failed")
  const body = (await res.json()) as Partial<ChangesetListPage>
  return {
    changesets: body.changesets ?? [],
    // Both absent on a pre-P1 worker: it caps nothing and holds nothing back,
    // so the honest client-side reading is "everything is surfaced".
    heldCount: typeof body.heldCount === "number" ? body.heldCount : 0,
    surfacedCap: typeof body.surfacedCap === "number" ? body.surfacedCap : SURFACED_CAP,
  }
}
