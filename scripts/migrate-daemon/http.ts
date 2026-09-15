// Retrying fetch + thin HTTP clients for the sync-worker /migrate/* surface
// and the GitLab API. No chunking/backpressure logic here — that belongs to
// the daemon's push loop (Task 6); this module is pure transport.
import type { IngestEvent } from "../../src/lib/migrate/types"
import type { ProjectionCell } from "../../src/lib/migrate/orphans"
import { MIGRATE_RUNNER_HEADER } from "../lib/migrate-runner-header"

export class HttpError extends Error {
  readonly status: number
  readonly body: string
  readonly retryable: boolean
  constructor(status: number, body: string, retryable: boolean) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
    this.retryable = retryable
  }
}
export interface RetryOpts {
  attempts?: number; baseMs?: number; maxMs?: number
  sleep?: (ms: number) => Promise<void>; random?: () => number
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function retryingFetch(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<Response> {
  const attempts = opts.attempts ?? 6, base = opts.baseMs ?? 1000, max = opts.maxMs ?? 60_000
  const sleep = opts.sleep ?? defaultSleep, random = opts.random ?? Math.random
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + random())
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      const body = await res.text().catch(() => "")
      const retryable = res.status >= 500 || res.status === 429
      if (!retryable) throw new HttpError(res.status, body, false)
      lastErr = new HttpError(res.status, body, true)
      const ra = Number(res.headers.get("Retry-After"))
      if (res.status === 429 && Number.isFinite(ra) && ra > 0) delay = ra * 1000
    } catch (e) {
      if (e instanceof HttpError && !e.retryable) throw e
      if (!(e instanceof HttpError)) lastErr = e
    }
    if (attempt < attempts) await sleep(Math.min(max, delay))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export interface InboxItem { key: string; gitlabId: number; sha: string; ts: number }
/** Must match `MAX_LIMIT` in sync-worker/src/events/migrate-webhook-route.ts —
 *  the Worker does one R2 `get` per key, so the page size is bounded by the
 *  subrequest cap, and `detect.ts` uses a short page to mean "drained". */
export const INBOX_PAGE = 200
export interface OrgTeamMaps { orgMap: Map<string, { id: number; ownerUserId: number }>; teamMap: Map<string, number> }

export class SyncClient {
  private readonly base: string
  private readonly secret: string
  private readonly runner: string
  private readonly retry: RetryOpts
  constructor(base: string, secret: string, runner: string, retry: RetryOpts = {}) {
    this.base = base
    this.secret = secret
    this.runner = runner
    this.retry = retry
  }
  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.secret}`, [MIGRATE_RUNNER_HEADER]: this.runner }
  }
  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await retryingFetch(`${this.base}${path}`, { ...init, headers: this.headers() }, this.retry)
    return (await res.json()) as T
  }
  upsertProject(b: { projectId: string; name: string; orgId: number; ownerUserId: number; teamId: number | null }): Promise<void> {
    return this.json<unknown>("/migrate/project", { method: "POST", body: JSON.stringify(b) }).then(() => undefined)
  }
  async ingest(projectId: string, events: IngestEvent[], eventsOnly = false): Promise<{ status: number; ms: number; accepted: number }> {
    const t0 = Date.now()
    const res = await retryingFetch(`${this.base}/migrate/ingest`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ projectId, events, eventsOnly, deferFileCounters: true }),
    }, this.retry)
    const { accepted } = (await res.json()) as { accepted: number }
    return { status: res.status, ms: Date.now() - t0, accepted }
  }
  finalize(projectId: string): Promise<void> {
    return this.json<unknown>("/migrate/finalize", { method: "POST", body: JSON.stringify({ projectId }) }).then(() => undefined)
  }
  async getSettings(projectId: string): Promise<Record<string, unknown>> {
    const r = await this.json<{ settings?: Record<string, unknown> }>(`/migrate/settings?projectId=${encodeURIComponent(projectId)}`)
    return r.settings ?? {}
  }
  postSettings(projectId: string, settings: Record<string, unknown>): Promise<void> {
    return this.json<unknown>("/migrate/settings", { method: "POST", body: JSON.stringify({ projectId, settings }) }).then(() => undefined)
  }
  async *eventIds(projectId: string, onPage?: () => Promise<void>): AsyncGenerator<string[]> {
    let after = 0
    for (;;) {
      if (onPage) await onPage()
      const page = await this.json<{ ids: string[]; lastSeq: number; more: boolean }>(
        `/migrate/event-ids?projectId=${encodeURIComponent(projectId)}&after=${after}&limit=50000`)
      yield page.ids
      if (!page.more) return
      after = page.lastSeq
    }
  }
  async eventCount(projectId: string): Promise<number> {
    return (await this.json<{ count: number }>(`/migrate/event-ids?projectId=${encodeURIComponent(projectId)}&count=1`)).count
  }
  async cellIds(projectId: string, fileId: string): Promise<ProjectionCell[]> {
    const out: ProjectionCell[] = []
    let after = ""
    for (;;) {
      const page = await this.json<{ cells: ProjectionCell[]; lastCellId: string; more: boolean }>(
        `/migrate/cell-ids?projectId=${encodeURIComponent(projectId)}&fileId=${encodeURIComponent(fileId)}&after=${encodeURIComponent(after)}&limit=20000`)
      out.push(...page.cells)
      if (!page.more) return out
      after = page.lastCellId
    }
  }
  // Mirrors scripts/migrate-all.ts fetchOrgTeamMaps() — same endpoint, same
  // key derivation. The response is keyed by legacy_uuid: `orgs[]` for orgs,
  // `groups[]` for GitLab groups (teams).
  async orgTeamMaps(): Promise<OrgTeamMaps> {
    const r = await this.json<{
      orgs: Array<{ legacyUuid: string; id: number; ownerUserId: number }>
      groups: Array<{ legacyUuid: string; id: number }>
    }>("/migrate/org-team-maps")
    return {
      orgMap: new Map(r.orgs.map((o) => [o.legacyUuid, { id: o.id, ownerUserId: o.ownerUserId }])),
      teamMap: new Map(r.groups.map((g) => [g.legacyUuid, g.id])),
    }
  }
  inbox(after: string | undefined): Promise<{ items: InboxItem[]; last: string | undefined }> {
    const q = `limit=${INBOX_PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`
    return this.json(`/migrate/webhook/inbox?${q}`)
  }
}

export interface GitLabProjectLite {
  id: number; name: string; namespace: string; path_with_namespace: string
  last_activity_at: string; http_url_to_repo: string; default_branch: string
}
interface GitLabProjectRaw {
  id: number; name: string; path_with_namespace: string; namespace?: { full_path?: string }
  last_activity_at: string; http_url_to_repo: string; default_branch?: string | null
}
const lite = (p: GitLabProjectRaw): GitLabProjectLite => ({
  id: p.id, name: p.name, path_with_namespace: p.path_with_namespace,
  namespace: p.namespace?.full_path ?? p.path_with_namespace.split("/").slice(0, -1).join("/"),
  last_activity_at: p.last_activity_at, http_url_to_repo: p.http_url_to_repo, default_branch: p.default_branch ?? "main",
})

export class GitLabClient {
  private readonly url: string
  private readonly token: string
  private readonly retry: RetryOpts
  constructor(url: string, token: string, retry: RetryOpts = {}) {
    this.url = url
    this.token = token
    this.retry = retry
  }
  private get(path: string): Promise<Response> {
    return retryingFetch(`${this.url}/api/v4${path}`, { headers: { Authorization: `Bearer ${this.token}` } }, this.retry)
  }
  async *listProjectsByActivity(sinceIso: string | undefined): AsyncGenerator<GitLabProjectLite> {
    let page = "1"
    while (page) {
      const res = await this.get(`/projects?per_page=100&order_by=last_activity_at&sort=desc&page=${page}`)
      const rows = (await res.json()) as GitLabProjectRaw[]
      for (const r of rows) {
        if (sinceIso && r.last_activity_at <= sinceIso) return
        yield lite(r)
      }
      page = res.headers.get("x-next-page") ?? ""
    }
  }
  async project(id: number): Promise<GitLabProjectLite | null> {
    try { return lite((await (await this.get(`/projects/${id}`)).json()) as GitLabProjectRaw) }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }
  }
  async headSha(id: number, branch: string): Promise<string | null> {
    const res = await this.get(`/projects/${id}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`)
    const rows = (await res.json()) as Array<{ id: string }>
    return rows[0]?.id ?? null
  }
  async rawFile(id: number, filePath: string, ref: string): Promise<string | null> {
    try { return await (await this.get(`/projects/${id}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`)).text() }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }
  }
}
