/**
 * AQU-2321: the Places lens's edit calls.
 *
 * - `fetchRemovalPreview` — POST /orgs/:id/access/removal-preview, the dry
 *   run (auth-worker/src/services/removal-preview.ts). Writes nothing.
 * - `removeGrants` — each grant through the route that owns it, naming the
 *   person by userId:
 *     org      DELETE /orgs/:id/members/:u       (also takes their teams)
 *     team     DELETE /orgs/:id/groups/:g/members/:u
 *     project  DELETE /projects/:p/members/:u
 *     invite   DELETE /orgs/:id/invites/:t  or  /projects/:p/invites/:t
 *   Every one of them tells the sync-worker to eject live sessions on the
 *   projects the person lost (AQU-346; org and team since AQU-2321).
 *   Not atomic: they run one after another and the result says how far it got.
 * - `changeGrantRole` — team by userId (PATCH .../members/:u); org and project
 *   through the add routes, which take a username: the roster's own username
 *   field, never the display name, and the account written is checked.
 */
import { addOrgMember, removeOrgMember, revokeProjectInvite } from "@/lib/frontier/orgs"
import { revokeOrgInvite } from "@/lib/frontier/invites"
import { addProjectMember, removeProjectMember } from "@/lib/frontier/members"
import { removeTeamMember, setTeamMemberRole } from "@/lib/frontier/teams"
import { UserError } from "@/lib/errors/user-error"
import { grantKey, type GrantRef } from "@/lib/access/edit-access"
import type { ScopeRef } from "@/lib/access/types"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"

import { writableUsername, type EffectiveRole } from "./give-access-data"

/** Mirrors auth-worker/src/services/removal-preview.ts RemovalPreview. */
export interface KeptAccess {
  project: ScopeRef
  roleBefore: number
  after: EffectiveRole
  grant: GrantRef | null
  grantedAt: string | null
  removable: boolean
}
export interface RemovalPreview {
  person: { userId: string; displayName: string }
  invite: boolean
  removes: { grant: GrantRef; path: ScopeRef[]; roleLevel: number | null }[]
  loses: ScopeRef[]
  keeps: KeptAccess[]
  leavesTeams: ScopeRef[]
  guest: { before: boolean; after: boolean }
}

export type RemovalState =
  | { status: "loading" }
  | { status: "ready"; preview: RemovalPreview }
  | { status: "refused"; message: string }
  | { status: "error" }

/** The surviving grants this viewer may remove too: one per grant, however many projects it keeps. */
export function extraGrants(preview: RemovalPreview, removing: readonly GrantRef[]): { grant: GrantRef; kept: KeptAccess }[] {
  const taken = new Set(removing.map(grantKey))
  const out = new Map<string, { grant: GrantRef; kept: KeptAccess }>()
  for (const kept of preview.keeps) {
    if (!kept.grant || !kept.removable || taken.has(grantKey(kept.grant)) || out.has(grantKey(kept.grant))) continue
    out.set(grantKey(kept.grant), { grant: kept.grant, kept })
  }
  return [...out.values()]
}

export type RemovalPerson = { userId: string } | { inviteId: string }

export type RemovalPreviewResult =
  | { ok: true; preview: RemovalPreview }
  /** The server refused: its message names the place and the reason. */
  | { ok: false; refused: { code: string; message: string } }

export async function fetchRemovalPreview(
  jwt: string,
  orgId: number,
  body: { person: RemovalPerson; grants: GrantRef[] },
  apiUrl: string = FRONTIER_API_URL,
): Promise<RemovalPreviewResult> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/access/removal-preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true, preview: ((await res.json()) as { preview: RemovalPreview }).preview }
  const text = await res.text().catch(() => "")
  if (res.status === 403 || res.status === 409) {
    try {
      const parsed = JSON.parse(text) as { code?: string; error?: string }
      if (parsed.code && parsed.error) return { ok: false, refused: { code: parsed.code, message: parsed.error } }
    } catch {
      // not a refusal body; fall through to the generic error
    }
  }
  throw new UserError(res.status, text, "org")
}

/** How far a removal got. `done` counts grants removed before the first failure. */
export interface RemovalOutcome {
  done: number
  total: number
  error: unknown | null
}

export async function removeGrants(
  jwt: string,
  orgId: number,
  person: RemovalPerson,
  grants: readonly GrantRef[],
): Promise<RemovalOutcome> {
  const steps: (() => Promise<unknown>)[] = "inviteId" in person
    ? [() => cancelInvite(jwt, orgId, person.inviteId)]
    : grants.map((grant) => () => removeOne(jwt, orgId, Number(person.userId), grant))
  let done = 0
  for (const step of steps) {
    try {
      await step()
      done += 1
    } catch (error) {
      return { done, total: steps.length, error }
    }
  }
  return { done, total: steps.length, error: null }
}

function removeOne(jwt: string, orgId: number, userId: number, grant: GrantRef): Promise<void> {
  if (grant.type === "org") return removeOrgMember(jwt, orgId, userId)
  if (grant.type === "team") return removeTeamMember(jwt, orgId, Number(grant.id), userId)
  return removeProjectMember(jwt, grant.id, userId)
}

/** invite:org:<token> or invite:project:<projectId>:<token> (the People-lens row id). */
async function cancelInvite(jwt: string, orgId: number, inviteId: string): Promise<void> {
  const org = /^invite:org:(.+)$/.exec(inviteId)
  if (org) return revokeOrgInvite(jwt, orgId, org[1])
  const project = /^invite:project:(.+):([^:]+)$/.exec(inviteId)
  if (!project) throw new UserError(400, "unrecognised invitation", "invite")
  const removed = await revokeProjectInvite(jwt, project[1], project[2])
  // Already redeemed or revoked elsewhere: say so rather than report a cancel that did nothing.
  if (!removed) throw new UserError(409, "this invitation was already used or cancelled", "invite")
}

export async function changeGrantRole(
  jwt: string,
  orgId: number,
  person: { userId: string; username: string | null },
  grant: GrantRef,
  roleLevel: number,
): Promise<void> {
  if (grant.type === "team") {
    await setTeamMemberRole(jwt, orgId, Number(grant.id), Number(person.userId), roleLevel)
    return
  }
  const username = writableUsername(person)
  // No lane choice: the route keeps the lanes they hold and rewrites only the level (AQU-1782).
  const written = grant.type === "org"
    ? await addOrgMember(jwt, orgId, username, roleLevel)
    : await addProjectMember(jwt, grant.id, username, roleLevel)
  if (written && String(written.userId) !== person.userId) {
    throw new UserError(409, `wrote account ${written.userId}, expected ${person.userId}`, grant.type)
  }
}
