/**
 * The HTTP surface the AQU-1868 perf harness drives, and nothing else.
 *
 * Deliberately standalone rather than shared with `e2e/helpers/*`: those
 * helpers take their session from Playwright's persisted auth state and are
 * typed for the e2e tsconfig, while the harness has to run as a plain Node
 * script (`tsx`) against a dev stack or a deployed target. What it must not
 * do is invent its own write path — every call below is the same endpoint,
 * body shape and token boundary the SPA uses, so a measured p95 is the
 * product's p95 and not an artifact of the harness.
 */

export interface PerfTarget {
  /** auth-worker origin — dev stack default :8788. */
  authBase: string
  /** sync-worker origin — dev stack default :8789. */
  syncBase: string
}

export const DEFAULT_TARGET: PerfTarget = {
  authBase: process.env.PERF_AUTH_BASE ?? "http://127.0.0.1:8788",
  syncBase: process.env.PERF_SYNC_BASE ?? "http://127.0.0.1:8789",
}

export class PerfHttpError extends Error {
  // Plain fields, not parameter properties: the scripts tsconfig runs with
  // `erasableSyntaxOnly`.
  readonly operation: string
  readonly status: number
  readonly body: string

  constructor(operation: string, status: number, body: string) {
    super(`${operation} failed: HTTP ${status} — ${body.slice(0, 400)}`)
    this.name = "PerfHttpError"
    this.operation = operation
    this.status = status
    this.body = body
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH"
  token?: string
  body?: unknown
  /** Retries for transport faults and 5xx — a wrangler worker restarting mid-seed. */
  retries?: number
  /** Accept these non-2xx statuses as a result instead of throwing. */
  allowStatus?: readonly number[]
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** One request, with bounded retry. Returns the parsed JSON body. */
export async function request<T>(
  url: string,
  operation: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: T }> {
  const { method = "GET", token, body, retries = 3, allowStatus = [] } = options
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1))
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      lastError = error
      continue
    }
    if (response.ok || allowStatus.includes(response.status)) {
      const text = await response.text()
      return { status: response.status, body: (text ? JSON.parse(text) : null) as T }
    }
    const text = await response.text()
    lastError = new PerfHttpError(operation, response.status, text)
    // 4xx is a contract error — retrying it only hides the message.
    if (response.status < 500) break
  }
  throw lastError instanceof Error ? lastError : new Error(`${operation} failed: ${String(lastError)}`)
}

export interface PerfSession {
  jwt: string
  username: string
}

/**
 * Sign in through the dev stack's local-only `/__dev__/login` as the seeded
 * `dev` user — the SAME identity the browser gets from `/__dev/login`, which
 * is what lets the browser probe open the project this harness seeded.
 * 404s unless the auth-worker runs with WRANGLER_LOCAL=1.
 */
export async function devLogin(target: PerfTarget, username = "dev"): Promise<PerfSession> {
  const { body } = await request<{ access_token: string; username: string }>(
    `${target.authBase}/__dev__/login`,
    "dev login",
    { method: "POST", body: { username } },
  )
  if (!body?.access_token) {
    throw new Error(
      "dev login returned no access_token — is the dev stack running (`pnpm dev`) with WRANGLER_LOCAL=1?",
    )
  }
  return { jwt: body.access_token, username: body.username }
}

export interface CreatedProject {
  id: string
  name: string
  orgId: number
}

export async function createProject(
  target: PerfTarget,
  jwt: string,
  args: { id: string; name: string },
): Promise<CreatedProject> {
  const { body } = await request<CreatedProject>(
    `${target.authBase}/api/v2/projects`,
    "create project",
    { method: "POST", token: jwt, body: args },
  )
  return body
}

export interface ProjectLane {
  id: string
  role: "source" | "target"
  name: string
  language?: string | null
  langCode: string | null
  legacyTag: string | null
}

export async function readLanes(
  target: PerfTarget,
  jwt: string,
  projectId: string,
): Promise<ProjectLane[]> {
  const { body } = await request<{ lanes?: ProjectLane[] }>(
    `${target.authBase}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    "read lanes",
    { token: jwt },
  )
  return body.lanes ?? []
}

export async function patchLane(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  laneId: string,
  patch: { name?: string | null; language?: string; code?: string | null },
): Promise<ProjectLane> {
  const { body } = await request<{ lane?: ProjectLane } & ProjectLane>(
    `${target.authBase}/api/v2/projects/${encodeURIComponent(projectId)}/lanes/${encodeURIComponent(laneId)}`,
    "patch lane",
    { method: "PATCH", token: jwt, body: patch },
  )
  return body.lane ?? body
}

export async function createLane(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  input: { name: string; language: string; code?: string | null },
): Promise<ProjectLane> {
  const { body } = await request<{ lane?: ProjectLane }>(
    `${target.authBase}/api/v2/projects/${encodeURIComponent(projectId)}/lanes`,
    "create lane",
    { method: "POST", token: jwt, body: input },
  )
  if (!body.lane) throw new Error("create lane returned no lane")
  return body.lane
}

/** POST /api/v2/sync-token — a (project, file)-scoped token, as the SPA mints. */
export async function mintSyncToken(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  fileId: string,
): Promise<string> {
  const { body } = await request<{ token: string }>(
    `${target.authBase}/api/v2/sync-token`,
    "mint sync token",
    { method: "POST", token: jwt, body: { projectId, fileId } },
  )
  return body.token
}

export interface ImportCellInput {
  id: string
  cellId: string
  anchorCellId: string | null
  value: string
  type?: string
  canonicalRef?: string
  sequenceIndex?: number
}

export interface ImportTargetInput {
  id: string
  cellId: string
  parentId: string
  value: string
  targetLang?: string
}

export interface ImportFileMetaInput {
  name: string
  fileType: string
  kind: string
  importFormat: string
  parserVersion: string
}

/** POST /import — the bulk source-import fast path the UI import uses. */
export async function bulkImport(
  target: PerfTarget,
  token: string,
  body: {
    projectId: string
    fileId: string
    file?: { id: string; role: "source" } & ImportFileMetaInput
    cells: ImportCellInput[]
    targets?: ImportTargetInput[]
    complete?: boolean
    clientTs?: number
  },
): Promise<{ accepted?: number; fileId?: string }> {
  const result = await request<{ accepted?: number; fileId?: string }>(
    `${target.syncBase}/import`,
    "bulk import",
    { method: "POST", token, body },
  )
  return result.body ?? {}
}

export interface RawEventInput {
  id: string
  schemaVersion: number
  kind: string
  projectId: string
  fileId?: string
  cellId?: string
  parentId?: string | null
  author: string
  payload: Record<string, unknown>
  clientTs: number
}

export interface EventsWriteResult {
  accepted?: number
  stale?: unknown[]
}

/** POST /events — the generic AD-2 ingestion endpoint the outbox flushes to. */
export async function postEvents(
  target: PerfTarget,
  token: string,
  events: RawEventInput[],
): Promise<EventsWriteResult> {
  const { body } = await request<EventsWriteResult>(`${target.syncBase}/events`, "post events", {
    method: "POST",
    token,
    body: { events },
    retries: 0, // a measured write is one attempt; a retry would hide the latency
  })
  return body ?? {}
}

export interface CellsPage {
  cells: Array<{ cellId: string; side: string; eventId: string; value: string }>
  nextCursor?: string | null
  maxServerSeq?: number
  projectEpoch?: number
}

export async function readCellsPage(
  target: PerfTarget,
  token: string,
  projectId: string,
  fileId: string,
  query: { limit?: number; cursor?: string | null; side?: "source" | "target" } = {},
): Promise<CellsPage> {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set("limit", String(query.limit))
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.side) params.set("side", query.side)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  const { body } = await request<CellsPage>(
    `${target.syncBase}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/cells${suffix}`,
    "read cells",
    { token },
  )
  return body
}

export async function readProgress(
  target: PerfTarget,
  token: string,
  projectId: string,
  fileId: string,
): Promise<unknown> {
  const { body } = await request<unknown>(
    `${target.syncBase}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/progress`,
    "read progress",
    { token },
  )
  return body
}

export interface ProjectFileRow {
  id: string
  name: string
  role?: string
  cellCount?: number
}

export async function readFiles(
  target: PerfTarget,
  token: string,
  projectId: string,
): Promise<ProjectFileRow[]> {
  const { body } = await request<{ files?: ProjectFileRow[] }>(
    `${target.syncBase}/api/v1/projects/${encodeURIComponent(projectId)}/files`,
    "read files",
    { token },
  )
  return body.files ?? []
}

/**
 * WS URL for a project's `ProjectSync` Durable Object. Mirrors
 * `buildProjectWsUrl` in `src/lib/sync/ws-reconciler.ts` — inlined because
 * importing that module pulls the browser outbox (IndexedDB) into a Node
 * script. If the path or params change there, change them here.
 */
export function projectWsUrl(
  syncBase: string,
  projectId: string,
  token: string | null,
  userId?: string | null,
  connId?: string | null,
): string {
  const wsBase = syncBase
    .replace(/^https?:\/\//, (match) => (match === "https://" ? "wss://" : "ws://"))
    .replace(/\/+$/, "")
  const params: string[] = []
  if (token) params.push(`token=${encodeURIComponent(token)}`)
  if (userId) params.push(`user=${encodeURIComponent(userId)}`)
  if (connId) params.push(`connId=${encodeURIComponent(connId)}`)
  const suffix = params.length > 0 ? `?${params.join("&")}` : ""
  return `${wsBase}/parties/project-sync/${encodeURIComponent(projectId)}${suffix}`
}
