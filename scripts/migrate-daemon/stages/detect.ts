// Stage 1: discover Codex projects and enqueue content jobs — either from the
// sync-worker's webhook inbox (near-real-time) or a full GitLab activity
// reconcile (catches anything the webhook missed). Placement (which org/team
// a project lands under) mirrors scripts/migrate-all.ts's placeIdx exactly.
import { detectCodexProject, listDescendantGroups, listTopLevelGroups, type GitLabProject } from "../../../src/lib/migrate/gitlab/api"
import type { GitLabCredentials } from "../../../src/lib/migrate/gitlab/auth"
import { orgLegacyUuidFor, projectIdFor, teamLegacyUuidFor } from "../../../src/lib/migrate/ids"
import type { DaemonDb } from "../db"
import { INBOX_PAGE, type GitLabClient, type GitLabProjectLite, type SyncClient } from "../http"
import { CONTENT_LOGIC_VERSION } from "./materialize"

export interface PlacementIndex {
  resolve(namespace: string): { orgId: number; ownerUserId: number; teamId: number | null } | undefined
}

export interface DetectDeps {
  db: DaemonDb
  sync: Pick<SyncClient, "inbox" | "orgTeamMaps">
  gitlab: GitLabClient
  creds: GitLabCredentials
  placement: PlacementIndex
  log: (m: string) => void
  /** Injectable Codex-ness probe; defaults to detectCodexProject against `creds`. */
  probe?: (p: GitLabProjectLite) => Promise<boolean>
}

const toGitLabProject = (p: GitLabProjectLite): GitLabProject => ({
  id: p.id, name: p.name, path_with_namespace: p.path_with_namespace,
  default_branch: p.default_branch, http_url_to_repo: p.http_url_to_repo, last_activity_at: p.last_activity_at,
})

/**
 * Build the namespace → org/team placement index from the live GitLab group
 * tree, mirroring migrate-all.ts's placeIdx construction exactly (same
 * orgLegacyUuidFor/teamLegacyUuidFor derivation), then cross-reference the
 * target's org/team ids via `sync.orgTeamMaps()`. `resolve` returns undefined
 * — logging which — both when the namespace has no group in the tree and
 * when its group exists but the org isn't provisioned on the target yet.
 */
export async function buildPlacementIndex(
  creds: GitLabCredentials,
  sync: Pick<SyncClient, "orgTeamMaps">,
  log: (m: string) => void = () => {},
): Promise<PlacementIndex> {
  const placeIdx = new Map<string, { orgLegacyUuid: string; teamLegacyUuid: string | null }>()
  for (const top of await listTopLevelGroups(creds)) {
    placeIdx.set(top.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: null })
    for (const d of await listDescendantGroups(creds, top.id)) {
      placeIdx.set(d.full_path, { orgLegacyUuid: orgLegacyUuidFor(top.id), teamLegacyUuid: teamLegacyUuidFor(d.id) })
    }
  }
  const { orgMap, teamMap } = await sync.orgTeamMaps()
  return {
    resolve(namespace: string) {
      const place = placeIdx.get(namespace)
      if (!place) {
        log(`placement: no group in GitLab tree matches namespace "${namespace}"`)
        return undefined
      }
      const org = orgMap.get(place.orgLegacyUuid)
      if (!org) {
        log(`placement: org for namespace "${namespace}" not provisioned on target (run migrate-groups --apply)`)
        return undefined
      }
      const teamId = place.teamLegacyUuid ? (teamMap.get(place.teamLegacyUuid) ?? null) : null
      return { orgId: org.id, ownerUserId: org.ownerUserId, teamId }
    },
  }
}

/**
 * Probe a project for Codex-ness, resolve its org/team placement, and either
 * upsert it as unmapped (no job) or upsert + enqueue a content job when its
 * head sha differs from what's already applied. `sha` may be a known value
 * (webhook payload) or null (reconcile / caller doesn't know it yet), in
 * which case the current head is fetched. A missing head sha is a hard
 * failure — it must never be silently treated as "nothing changed."
 */
export async function registerProject(
  deps: DetectDeps,
  p: GitLabProjectLite,
  sha: string | null,
): Promise<"enqueued" | "unmapped" | "not-codex" | "unchanged"> {
  const probe = deps.probe ?? ((proj: GitLabProjectLite) => detectCodexProject(deps.creds, toGitLabProject(proj)).then((m) => m !== null))
  if (!(await probe(p))) return "not-codex"

  const place = deps.placement.resolve(p.namespace)
  const aquillaId = projectIdFor(String(p.id), "gitlab")
  if (!place) {
    deps.db.upsertProject({
      gitlab_id: p.id, aquilla_id: aquillaId, name: p.name, namespace: p.namespace,
      org_id: null, team_id: null, owner_user_id: null, last_activity_at: p.last_activity_at, status: "unmapped",
    })
    return "unmapped"
  }

  deps.db.upsertProject({
    gitlab_id: p.id, aquilla_id: aquillaId, name: p.name, namespace: p.namespace,
    org_id: place.orgId, team_id: place.teamId, owner_user_id: place.ownerUserId,
    last_activity_at: p.last_activity_at, status: "ok",
  })

  let resolvedSha = sha
  if (resolvedSha === null) resolvedSha = await deps.gitlab.headSha(p.id, p.default_branch)
  if (resolvedSha === null) throw new Error(`no head sha for project ${p.id} (${p.namespace}/${p.name})`)

  const existing = deps.db.getProject(p.id)
  if (existing && existing.applied_sha === resolvedSha && existing.content_logic === CONTENT_LOGIC_VERSION) return "unchanged"

  deps.db.enqueue(p.id, "content", resolvedSha)
  return "enqueued"
}

/**
 * Drain the sync-worker webhook inbox since the last cursor, following pages
 * until one comes back short. Duplicate
 * gitlabIds within one batch collapse to the last (latest-sha) occurrence
 * before registering, so one project only gets probed/upserted once per poll.
 */
export async function pollInbox(deps: DetectDeps): Promise<number> {
  let after = deps.db.kvGet("inbox_cursor")
  const byProject = new Map<number, string>()
  // The inbox is paged (INBOX_PAGE per request, bounded by the Worker's
  // subrequest cap), so drain until a short page says there is no more.
  let last: string | undefined
  for (;;) {
    const page = await deps.sync.inbox(after)
    for (const item of page.items) byProject.set(item.gitlabId, item.sha)
    if (page.last !== undefined) { last = page.last; after = page.last }
    if (page.items.length < INBOX_PAGE) break
  }

  let enqueued = 0
  for (const [gitlabId, sha] of byProject) {
    const p = await deps.gitlab.project(gitlabId)
    if (!p) { deps.log(`inbox: project ${gitlabId} not found on GitLab, skipping`); continue }
    try {
      if ((await registerProject(deps, p, sha || null)) === "enqueued") enqueued++
    } catch (e) {
      deps.log(`inbox: registerProject failed for ${gitlabId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (last !== undefined) deps.db.kvSet("inbox_cursor", last)
  return enqueued
}

/**
 * Full GitLab activity sweep, newest-first, stopping at the high-water mark
 * from the previous run. The hwm only advances if the whole sweep completes
 * without a listing error — a single project's registerProject failure is
 * logged and skipped, but a listing failure aborts without moving the hwm so
 * the next run re-covers the same window.
 */
export async function reconcile(deps: DetectDeps): Promise<number> {
  const hwm = deps.db.kvGet("reconcile_hwm")
  let max = hwm
  let enqueued = 0
  for await (const p of deps.gitlab.listProjectsByActivity(hwm)) {
    if (!max || p.last_activity_at > max) max = p.last_activity_at
    try {
      if ((await registerProject(deps, p, null)) === "enqueued") enqueued++
    } catch (e) {
      deps.log(`reconcile: registerProject failed for ${p.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (max !== undefined) deps.db.kvSet("reconcile_hwm", max)
  return enqueued
}
