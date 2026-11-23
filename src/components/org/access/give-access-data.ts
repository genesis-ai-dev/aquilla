/**
 * AQU-2320: the Give access dialog's two calls.
 *
 * - `fetchGrantPreview` — POST /api/v2/orgs/:orgId/access/preview, the dry
 *   run (auth-worker/src/services/grant-preview.ts). Writes nothing.
 * - `submitGrant` — writes ONE grant through the route that already owns that
 *   kind of place, so every cap those routes enforce still applies:
 *     org      POST /orgs/:id/members (or /orgs/:id/invites for an email)
 *     team     POST /orgs/:id/groups/:g/members, then PATCH its team role
 *     project  POST /projects/:p/members with every current lane
 *              (or /projects/:p/invites for an email)
 *     lane     the same two routes, narrowed to that one lane
 */
import { addOrgMember, createOrgInvite } from "@/lib/frontier/orgs"
import { addProjectMember } from "@/lib/frontier/members"
import { addTeamMembers, setTeamMemberRole } from "@/lib/frontier/teams"
import { UserError } from "@/lib/errors/user-error"
import type { PersonChoice, PlaceRow } from "@/lib/access/give-access"
import type { ScopeRef } from "@/lib/access/types"
import { createServerInvite } from "@/lib/sync/invites"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"

/** Mirrors auth-worker/src/services/grant-preview.ts GrantPreview. */
export interface EffectiveRole {
  roleLevel: number
  source: "direct" | "team" | "org" | "creator" | "lane"
  via: ScopeRef
}
export interface GrantPreview {
  placePath: ScopeRef[]
  roleLevel: number
  invite: boolean
  here: { before: EffectiveRole | null; after: EffectiveRole | null }
  replaces: number | null
  changes: { project: ScopeRef; before: EffectiveRole | null; after: EffectiveRole | null }[]
  redundant: boolean
  guest: { before: boolean; after: boolean }
  includesFutureProjects: boolean
}

export type PreviewResult =
  | { ok: true; preview: GrantPreview }
  /** The server refused: its message names the place, the role and the cap. */
  | { ok: false; refused: { code: string; message: string } }

export async function fetchGrantPreview(
  jwt: string,
  orgId: number,
  body: unknown,
  apiUrl: string = FRONTIER_API_URL,
): Promise<PreviewResult> {
  const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/access/preview`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true, preview: ((await res.json()) as { preview: GrantPreview }).preview }
  const text = await res.text().catch(() => "")
  if (res.status === 400 || res.status === 403 || res.status === 409) {
    try {
      const parsed = JSON.parse(text) as { code?: string; error?: string }
      if (parsed.code && parsed.error) return { ok: false, refused: { code: parsed.code, message: parsed.error } }
    } catch {
      // not a refusal body; fall through to the generic error
    }
  }
  throw new UserError(res.status, text, "org")
}

export async function submitGrant(
  jwt: string,
  orgId: number,
  grant: { person: PersonChoice; roleLevel: number; place: PlaceRow },
): Promise<void> {
  const { person, roleLevel, place } = grant
  const { type, id } = place.scope
  if (person.kind === "invite") {
    if (type === "org") {
      await createOrgInvite(jwt, orgId, { email: person.email, role: roleLevel })
      return
    }
    const projectId = place.projectId ?? id
    const lanes = type === "lane" ? [id] : undefined
    const created = await createServerInvite(jwt, projectId, roleLevel, undefined, person.email, undefined, lanes, lanes ? undefined : true)
    if (!created) throw new UserError(500, "", "project")
    return
  }
  // The dry run named this person by userId. These routes take a username, so
  // the write names them by the account's own username — never the display
  // name — and refuses when the payload carried none.
  const username = writableUsername(person)
  if (type === "org") {
    sameAccount(person, await addOrgMember(jwt, orgId, username, roleLevel), "org")
    return
  }
  if (type === "team") {
    const teamId = Number(id)
    // A guest joins the team without an org row (AQU-2238); a member joins as themselves.
    const [added] = await addTeamMembers(jwt, orgId, teamId, [username], { external: person.isGuest })
    if (!added?.ok) throw new UserError(409, added?.error?.message ?? "", "team")
    await setTeamMemberRole(jwt, orgId, teamId, Number(person.userId), roleLevel)
    return
  }
  const projectId = place.projectId ?? id
  const written = await addProjectMember(
    jwt,
    projectId,
    username,
    roleLevel,
    type === "lane" ? { scopeLanes: [id] } : { allCurrentLanes: true },
  )
  sameAccount(person, written, "project")
}

/** The lookup key for a write by name. Missing means the payload cannot say who this is. */
export function writableUsername(person: { username: string | null }): string {
  if (!person.username) throw new UserError(409, "this person has no username to write by", "org")
  return person.username
}

/** The route reports the account it wrote. One the dry run did not name is a loud failure, not a success. */
function sameAccount(person: { userId: string }, written: { userId: number | string } | undefined, kind: "org" | "project"): void {
  if (written && String(written.userId) !== person.userId) {
    throw new UserError(409, `wrote account ${written.userId}, expected ${person.userId}`, kind)
  }
}
