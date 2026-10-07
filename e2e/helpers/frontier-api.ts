/**
 * Thin HTTP client for the identity worker, used by E2E specs to set up
 * server-side state (projects, org members, project members) without
 * driving brittle UI flows.
 *
 * The production app uses the same endpoints via wrappers in
 * src/lib/frontier/. This helper duplicates the minimal subset needed
 * for tests rather than importing from src/ to keep the test surface
 * isolated from product code refactors.
 *
 * Role levels (mirror src/lib/frontier/roles.ts):
 *   100 viewer, 200 commenter, 300 reviewer, 400 contributor,
 *   500 project_lead, 600 maintainer, 700 owner.
 */

import { RETIRED_LANE_SETTINGS_KEYS } from "../../db/shared/retired-lane-settings"
import { postIdempotentJson } from "./idempotent-request"

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

function authHeaders(jwt: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

export interface MyOrg {
  id: number
  name: string | null
  role: { level: number; name: string }
}

/** GET /api/v2/orgs/me — alice's seeded "Acme" org. Returns the row even
 * if she's never explicitly created one (frontier-server lazy-creates a
 * personal org on first call). */
export async function getMyOrg(jwt: string): Promise<MyOrg> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/me`, { headers: authHeaders(jwt) })
  if (!r.ok) throw new Error(`getMyOrg failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as MyOrg
}

/** GET /api/v2/orgs — every organization visible to the caller. */
export async function listMyOrgs(jwt: string): Promise<MyOrg[]> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs`, { headers: authHeaders(jwt) })
  if (!r.ok) throw new Error(`listMyOrgs failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { orgs: MyOrg[] }).orgs
}

/** POST /api/v2/orgs — create a named org owned by the caller. */
export async function createOrg(jwt: string, name: string): Promise<MyOrg> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ name }),
  })
  if (!r.ok) throw new Error(`createOrg failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as MyOrg
}

/** POST /api/v2/orgs/:orgId/members — add a user to an org by username.
 * Caller must be owner/maintainer of the org. Used in tests where alice
 * adds bob to Acme. */
export async function addOrgMember(
  jwt: string,
  orgId: number,
  username: string,
  role: number = ROLE.CONTRIBUTOR,
): Promise<void> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/members`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ username, role }),
  })
  if (!r.ok) throw new Error(`addOrgMember failed: HTTP ${r.status} — ${await r.text()}`)
}

export interface CreatedProject {
  id: string
  name: string
  orgId: number
  role: { level: number; name: string }
}

/** POST /api/v2/projects — register a project server-side under the caller's
 * personal org. Used to bootstrap a project that has both local IDB state
 * AND a server-side row, so subsequent member-add and sync calls succeed. */
export async function createProjectServerSide(
  jwt: string,
  args: { id: string; name: string; orgId?: number },
): Promise<CreatedProject> {
  // The caller supplies a stable project id and the worker insert uses
  // ON CONFLICT(id) DO NOTHING, so replaying this byte-identical fixture POST
  // is safe when Wrangler restarts after accepting or during the request.
  const r = await postIdempotentJson({
    url: `${FRONTIER_BASE}/api/v2/projects`,
    headers: authHeaders(jwt),
    body: args,
    operation: "createProjectServerSide",
  })
  return (await r.json()) as CreatedProject
}

/** GET /api/v2/projects/:projectId/settings — the stored shared-settings blob,
 * for specs asserting that a UI save actually reached auth-worker. */
export async function readProjectSettings(
  jwt: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`read settings failed: HTTP ${r.status} — ${await r.text()}`)
  const stored = (await r.json()) as { settings?: Record<string, unknown> }
  return stored.settings ?? {}
}

/**
 * A settings body that names a retired lane key is not a language write.
 * Dropping the key and continuing would look like the language was set.
 * The in-app client omits stored copies (`settingsForPatch`); a caller that
 * still passes one has to create or patch a lane instead.
 */
function assertSettingsOmitRetiredLaneKeys(settings: Record<string, unknown>): void {
  const retired = RETIRED_LANE_SETTINGS_KEYS.filter((key) => key in settings)
  if (retired.length === 0) return
  throw new Error(
    `${retired.join(", ")} are not settings. ` +
      "Create a target lane with POST /api/v2/projects/:projectId/lanes " +
      "({ name, language, code? }) or set a lane's language with " +
      "PATCH /api/v2/projects/:projectId/lanes/:laneId ({ language, code? }).",
  )
}

/** Stored blobs may still hold the retired keys. Echoing them back is a 400. */
function withoutRetiredLaneSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings }
  for (const key of RETIRED_LANE_SETTINGS_KEYS) delete next[key]
  return next
}

/** PUT /api/v2/projects/:projectId/settings — merge keys into a project's
 * settings. Caller needs maintainer+ (the route's own floor). Retired lane
 * keys are omitted from the stored blob and rejected if the caller passes
 * them (AQU-1595). */
export async function updateProjectSettings(
  jwt: string,
  projectId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  assertSettingsOmitRetiredLaneKeys(settings)
  const current = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!current.ok) {
    throw new Error(`read settings failed: HTTP ${current.status} — ${await current.text()}`)
  }
  const stored = (await current.json()) as { settings?: Record<string, unknown>; version?: number }
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    {
      method: "PUT",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        settings: { ...withoutRetiredLaneSettings(stored.settings ?? {}), ...settings },
        ifMatchVersion: stored.version ?? 0,
      }),
    },
  )
  if (!r.ok) {
    throw new Error(`update settings failed: HTTP ${r.status} — ${await r.text()}`)
  }
}

/** One row of the `lanes` list GET …/settings returns alongside the blob. */
export interface ProjectLane {
  id: string
  role: "source" | "target"
  name: string
  /** Freeform language the user typed. Null or "" means the lane has none yet. */
  language?: string | null
  langCode: string | null
  legacyTag: string | null
  archivedAt: string | null
}

/** GET /api/v2/projects/:projectId/settings — the project's lane records
 * (what the lane switcher and Settings → Languages list), not the tag registry
 * in the settings blob. */
export async function readProjectLanes(jwt: string, projectId: string): Promise<ProjectLane[]> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/settings`,
    { headers: authHeaders(jwt) },
  )
  if (!r.ok) throw new Error(`read lanes failed: HTTP ${r.status} — ${await r.text()}`)
  return ((await r.json()) as { lanes?: ProjectLane[] }).lanes ?? []
}

function laneLanguageIsEmpty(lane: ProjectLane): boolean {
  return typeof lane.language !== "string" || lane.language.trim() === ""
}

/** POST /api/v2/projects/:projectId/lanes — one target lane.
 * Body matches createLaneSchema: { name, language, code? }. */
export async function createProjectLane(
  jwt: string,
  projectId: string,
  input: { name: string; language: string; code?: string | null },
): Promise<ProjectLane> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/lanes`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(input) },
  )
  if (!r.ok) throw new Error(`create lane failed: HTTP ${r.status} — ${await r.text()}`)
  const body = (await r.json()) as { lane?: ProjectLane }
  if (!body.lane) throw new Error("create lane failed: response had no lane")
  return body.lane
}

/** PATCH /api/v2/projects/:projectId/lanes/:laneId — language, name, or code.
 * Source and target rows both take this. */
export async function patchProjectLane(
  jwt: string,
  projectId: string,
  laneId: string,
  patch: { name?: string | null; language?: string; code?: string | null },
): Promise<ProjectLane> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/lanes/${encodeURIComponent(laneId)}`,
    { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify(patch) },
  )
  if (!r.ok) throw new Error(`patch lane failed: HTTP ${r.status} — ${await r.text()}`)
  const body = (await r.json()) as { lane?: ProjectLane }
  if (!body.lane) throw new Error("patch lane failed: response had no lane")
  return body.lane
}

/**
 * Languages live on lane rows, not in the settings blob (AQU-1595).
 *
 * The project create already inserted one source lane. When that row's
 * language is empty, this patches it. It does not create a source lane — a
 * second one is not a thing this API can express, and a missing row is a
 * failed seed rather than a silent gap. One target lane is created with
 * POST …/lanes; its `legacy_tag` must be the language, not `''`. The brief,
 * when given, is the only settings PUT.
 */
export async function setProjectLanguagePair(
  jwt: string,
  projectId: string,
  opts: {
    sourceLanguage: string
    sourceCode?: string
    targetLanguage: string
    targetCode?: string
    translationBrief?: Record<string, unknown>
  },
): Promise<void> {
  const lanes = await readProjectLanes(jwt, projectId)
  const source = lanes.find((lane) => lane.role === "source")
  if (!source) {
    throw new Error(
      `project ${projectId} has no source lane. A new project already has one (AQU-1594); ` +
        "refusing to create a second source lane.",
    )
  }
  if (laneLanguageIsEmpty(source)) {
    await patchProjectLane(jwt, projectId, source.id, {
      language: opts.sourceLanguage,
      ...(opts.sourceCode === undefined ? {} : { code: opts.sourceCode }),
    })
  }
  const target = await createProjectLane(jwt, projectId, {
    name: "",
    language: opts.targetLanguage,
    ...(opts.targetCode === undefined ? {} : { code: opts.targetCode }),
  })
  if (target.legacyTag !== opts.targetLanguage) {
    throw new Error(
      `target lane legacy_tag was ${JSON.stringify(target.legacyTag)}; ` +
        `the first target's legacy_tag must be its language (${JSON.stringify(opts.targetLanguage)}), not ''.`,
    )
  }
  if (opts.translationBrief !== undefined) {
    await updateProjectSettings(jwt, projectId, { translationBrief: opts.translationBrief })
  }
}

/** PATCH /api/v2/projects/:projectId/lanes/:laneId — rename a target lane, as
 * Settings → Languages does. Returns the HTTP status for the spec to assert. */
export async function renameProjectLane(
  jwt: string,
  projectId: string,
  laneId: string,
  name: string,
): Promise<number> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/lanes/${encodeURIComponent(laneId)}`,
    { method: "PATCH", headers: authHeaders(jwt), body: JSON.stringify({ name }) },
  )
  return r.status
}

/** POST /api/v2/projects/:projectId/link-source — make `projectId` read its
 * source from another project. `seeded` reports whether the upstream's files
 * and cells arrived before the call returned. */
export async function linkProjectToSource(
  jwt: string,
  projectId: string,
  args: {
    sourceProjectId: string
    mode: "clone" | "live"
    consumes?: "source" | "target"
    gate?: "head" | "validated"
    /** AQU-1559: the UPSTREAM file ids to follow; omit for the whole project. */
    fileIds?: string[]
  },
): Promise<{ seeded: boolean }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/link-source`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(args) },
  )
  if (!r.ok) throw new Error(`link-source failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { seeded: boolean }
}

export interface MergeSiblingResponse {
  merged?: number
  skipped?: Array<{ cellId: string; preview: string }>
  lane?: string
  /** AQU-1602: the donor lane that was folded, and the host lane it became. */
  donorLaneId?: string | null
  hostLaneId?: string | null
  /** AQU-1602: on a refused fold, the donor lanes to choose between. */
  donorLanes?: Array<{ id: string; name: string }>
  actions?: { laneRegistered: boolean; donorArchived: boolean; donorPointerWritten: boolean }
  error?: string
}

/** POST /api/v2/projects/:hostId/merge-sibling — fold a sibling project into
 * the host as one more target lane. There is no UI for this yet; the route is
 * the product surface. Returns status + body so a spec can assert a refusal. */
export async function mergeSiblingProject(
  jwt: string,
  hostProjectId: string,
  args: {
    donorProjectId: string
    lane: string
    /** AQU-1602: which of the donor's lanes to fold, by `lanes.id`. Omit it and
     *  the fold takes the donor's single active lane; a donor with several is
     *  refused with the candidates in `donorLanes`. */
    donorLaneId?: string
  },
): Promise<{ status: number; body: MergeSiblingResponse }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(hostProjectId)}/merge-sibling`,
    { method: "POST", headers: authHeaders(jwt), body: JSON.stringify(args) },
  )
  const text = await r.text()
  let body: MergeSiblingResponse
  try {
    body = JSON.parse(text) as MergeSiblingResponse
  } catch {
    body = { error: text }
  }
  return { status: r.status, body }
}

/** POST /api/v2/projects/:projectId/invites — mint a share-link invite
 * (caller needs project_lead+). Pass an email to email-bind it. */
export async function createProjectInvite(
  jwt: string,
  projectId: string,
  opts: { email?: string; role?: number } = {},
): Promise<{ token: string }> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/invites`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify(opts),
    },
  )
  if (!r.ok) throw new Error(`createProjectInvite failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { token: string }
}

/** POST /api/v2/orgs/:orgId/invites — mint an org invite (owner-only). */
export async function createOrgInvite(
  jwt: string,
  orgId: number,
  opts: { email?: string; role?: number } = {},
): Promise<{ token: string }> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/orgs/${orgId}/invites`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(opts),
  })
  if (!r.ok) throw new Error(`createOrgInvite failed: HTTP ${r.status} — ${await r.text()}`)
  return (await r.json()) as { token: string }
}

/** POST /api/v2/projects/:projectId/members — add a user to a project. */
export async function addProjectMember(
  jwt: string,
  projectId: string,
  username: string,
  role: number = ROLE.CONTRIBUTOR,
): Promise<void> {
  const r = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ username, role }),
    },
  )
  if (!r.ok) throw new Error(`addProjectMember failed: HTTP ${r.status} — ${await r.text()}`)
}

/** POST /api/v2/auth/register — mint a throwaway account for specs that need
 * more than the alice/bob/carol seed (AQU-1060). Does not persist a sidecar. */
export async function registerAccount(args: {
  username: string
  email: string
  password: string
}): Promise<{ jwt: string; username: string; email: string }> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  if (!r.ok) {
    throw new Error(`registerAccount failed: HTTP ${r.status} — ${await r.text()}`)
  }
  const body = (await r.json()) as { access_token: string }
  return { jwt: body.access_token, username: args.username, email: args.email }
}

/** Convenience: create project server-side AND add another user as a
 * contributor in one call. Returns the project id. */
export async function bootstrapSharedProject(
  ownerJwt: string,
  args: { id: string; name: string; collaboratorUsername: string; collaboratorRole?: number },
): Promise<CreatedProject> {
  const project = await createProjectServerSide(ownerJwt, { id: args.id, name: args.name })
  await addProjectMember(
    ownerJwt,
    project.id,
    args.collaboratorUsername,
    args.collaboratorRole ?? ROLE.CONTRIBUTOR,
  )
  return project
}
