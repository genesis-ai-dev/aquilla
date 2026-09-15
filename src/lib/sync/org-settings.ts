import { FRONTIER_API_URL } from "./sync-token"
import type { TranslationRule, PromotionRequest } from "@/lib/parsers/types"
import { t } from "@/lib/i18n/standalone"

/**
 * Provider-keyed map of org-scoped API keys. Keys are provider identifiers
 * (e.g. "gemini-tts") and values are the raw API key strings. These are set
 * once by an org owner/maintainer and apply as the baseline for all members
 * and projects in the org. Precedence at resolution time:
 *   project key > user (browser-local) key > org key
 *
 * AQU-433: extend to new providers by adding more entries here.
 */
export interface OrgProviderKeys {
  "gemini-tts"?: string
  [provider: string]: string | undefined
}

/**
 * The synced subset of org-wide settings. Shape is intentionally open (server
 * is a dumb store) but we type the known keys.
 */
export interface OrgWideSettings {
  rules?: TranslationRule[]
  promotionRequests?: PromotionRequest[]
  /**
   * AQU-253: Minimum role level required to export project deliverables.
   * Default (when absent) = MAINTAINER (600) per spec Q32. Org owners can
   * lower it (e.g., CONTRIBUTOR = 400) or raise it (e.g., OWNER = 700).
   * Matched against the sync-token role on every export/download request.
   */
  exportMinRole?: number
  /**
   * AQU-907: Minimum role level required to use the org-wide Data egress
   * surface (bulk zip of everything the org has). Default (when absent) =
   * OWNER (700) — the most restrictive floor, unlike exportMinRole's
   * MAINTAINER default, because one action here hands out the whole corpus.
   * OWNER-only on write (permission-policy key).
   */
  egressMinRole?: number
  /**
   * AQU-485: Minimum role level required to see the member roster (list +
   * count) on org and project surfaces. Default (when absent) = MAINTAINER
   * (600) — safe for sensitive teams that don't want to reveal who/how many
   * are on a project, even to their own members. Independent of
   * memberProgressViewMinRole: a team can show the roster while hiding
   * per-member progress, or vice versa.
   */
  rosterViewMinRole?: number
  /**
   * AQU-485: Minimum role level required to see per-member progress /
   * productivity. Default (when absent) = MAINTAINER (600). Separate from
   * rosterViewMinRole — being allowed to see WHO is on the team does not
   * imply being allowed to see WHAT each person did.
   *
   * AQU-498: consumed by ProjectOverview's Team card + the sync-worker's
   * member-activity-read-route (server-side floor via resolveMemberProgressFloor).
   */
  memberProgressViewMinRole?: number
  /**
   * AQU-496: whether members below project_lead (500) may emit
   * `assignment.create` for THEMSELVES (claim a book/take) — never for
   * anyone else. Default (when absent) = false, preserving the pre-AQU-496
   * leads-only behavior. Leads/maintainers can always assign regardless.
   * Same OWNER-only write gate as exportMinRole/rosterViewMinRole (see
   * EXPORT_FLOOR_WRITE_MIN_ROLE in auth-worker/src/routes/org-settings.ts) —
   * a maintainer must not be able to unilaterally loosen who can assign work.
   * Enforced server-side in sync-worker (authorize.ts self-assign carve-out).
   */
  allowSelfAssignment?: boolean
  /**
   * AQU-1083: the org-wide default for whether structural cells — chapter
   * headings, section titles, book names — count toward progress. Unset means
   * they DO, which is what every project did before this existed. A project
   * may override it.
   */
  countStructuralCells?: boolean
  /**
   * AQU-1037: Minimum effective project role allowed to assign, reassign, or
   * unassign file/chapter/target-lane work and route AI changesets. Default
   * (when absent) = PROJECT_LEAD (500), preserving prior behavior.
   */
  assignmentMinRole?: number
  /**
   * AQU-822: Minimum role level allowed to manage a project's termbase —
   * add, edit, delete, and archive concepts. Default (when absent) =
   * PROJECT_LEAD (500), the level the terminology UI has always shown the
   * editor at. Org owners can lower it (e.g. CONTRIBUTOR = 400, so
   * translators own their own terminology) or raise it.
   *
   * Lowering the floor grants FULL terminology management at that level —
   * there is no draft/suggestion/approval layer. It does NOT widen any other
   * project setting: the server carve-out applies only to a write whose sole
   * changed key is `terminology` (auth-worker project-settings route).
   *
   * Same OWNER-only write gate as exportMinRole / rosterViewMinRole.
   */
  termbaseEditMinRole?: number
  /**
   * AQU-1086: minimum org/project role allowed to change a project's source
   * and target language, and its extra target-lane registry (`targetLanes` /
   * `archivedLanes`). Unset ⇒ MAINTAINER (600), i.e. the behaviour before
   * this setting existed; an org opts in to project-lead language editing by
   * lowering it to 500.
   *
   * It does NOT widen any other project setting: the server carve-out applies
   * only to a write whose changed keys are all language keys (auth-worker
   * project-settings route).
   *
   * Same OWNER-only write gate as termbaseEditMinRole / exportMinRole.
   */
  languageEditMinRole?: number
  /**
   * AQU-1002: Minimum role level allowed to OPEN a comment thread or post a
   * reply. Default (when absent) = COMMENTER (200), the static
   * `comment.create` floor the app has always enforced.
   *
   * Raising it lets an org keep discussion to reviewers and above; lowering it
   * below COMMENTER has no practical effect, since VIEWER is the only rung
   * underneath and viewers have no write path at all.
   *
   * Same OWNER-only write gate as exportMinRole / termbaseEditMinRole.
   */
  commentCreateMinRole?: number
  /**
   * AQU-1002: Minimum role level allowed to resolve or reopen a thread that
   * SOMEBODY ELSE opened. Default (when absent) = CONTRIBUTOR (400), the
   * foreign-resolve floor AQU-999 hardened to.
   *
   * This is deliberately the *foreign* floor, not a flat one: a thread's own
   * author can always resolve their own thread, whatever the org sets. The
   * policy orgs disagreed about (and the reason this setting exists) is
   * authority over other people's threads — some partners want contributors
   * settling the threads on files they translate, others want that reserved
   * for maintainers.
   *
   * Enforced server-side in sync-worker on both write paths (the /events
   * perimeter and the external Agent API emit path).
   */
  commentResolveMinRole?: number
  /**
   * AQU-433: Org-scoped provider API keys. Set once by an org owner/maintainer;
   * used as the baseline for all members and projects in the org.
   * Precedence: project key > user (localStorage) key > org key.
   */
  orgProviderKeys?: OrgProviderKeys
}

export interface OrgSettingsResponse {
  orgId: number
  settings: OrgWideSettings
  version: number
  updatedAt: string | null
  updatedBy: number | null
  /**
   * AQU-1083: how many projects in this org carry their own
   * countStructuralCells and so ignore the org default.
   *
   * Absent from an older server, which reads as none — the prompt simply does
   * not appear, which is the pre-feature behaviour.
   */
  countStructuralOverrides?: number
}

export type OrgPatchResult =
  | { kind: "ok"; value: OrgSettingsResponse }
  | { kind: "conflict"; latest: OrgSettingsResponse }
  | { kind: "forbidden" }
  | { kind: "error"; status: number; message: string }

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/**
 * GET /api/v2/orgs/:orgId/settings.
 * Returns null on 403/404/network error — callers treat absence as empty.
 */
export async function fetchOrgSettings(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<OrgSettingsResponse | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/settings`, {
      headers: authHeaders(jwt),
    })
    if (!res.ok) return null
    return (await res.json()) as OrgSettingsResponse
  } catch {
    return null
  }
}

/**
 * PATCH /api/v2/orgs/:orgId/settings. Requires ifMatchVersion.
 * Non-maintainer callers get { kind: "forbidden" }.
 */
export async function patchOrgSettings(
  jwt: string,
  orgId: number,
  settings: OrgWideSettings,
  ifMatchVersion: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<OrgPatchResult> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/settings`, {
      method: "PATCH",
      headers: authHeaders(jwt),
      body: JSON.stringify({ settings, ifMatchVersion }),
    })
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.ok) {
    const value = (await res.json()) as OrgSettingsResponse
    return { kind: "ok", value }
  }
  if (res.status === 409) {
    const body = (await res.json()) as { current?: OrgSettingsResponse }
    if (body.current) return { kind: "conflict", latest: body.current }
    return { kind: "error", status: res.status, message: t("org.sync.versionConflictError") }
  }
  if (res.status === 403) {
    return { kind: "forbidden" }
  }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}

export type PromotionRequestResult =
  | { kind: "ok" }
  | { kind: "duplicate" }
  | { kind: "forbidden" }
  | { kind: "error"; status: number; message: string }

/**
 * POST /api/v2/orgs/:orgId/rule-promotion-requests.
 * Requires org role >= PROJECT_LEAD (500). Returns "duplicate" if an identical
 * request (same rule id + project) is already pending.
 */
export async function postPromotionRequest(
  jwt: string,
  orgId: number,
  rule: TranslationRule,
  sourceProjectId: string,
  apiUrl: string = FRONTIER_API_URL,
): Promise<PromotionRequestResult> {
  let res: Response
  try {
    res = await fetch(`${apiUrl}/api/v2/orgs/${orgId}/rule-promotion-requests`, {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({ rule, sourceProjectId }),
    })
  } catch (e) {
    return { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) }
  }
  if (res.ok) return { kind: "ok" }
  if (res.status === 409) return { kind: "duplicate" }
  if (res.status === 403) return { kind: "forbidden" }
  const text = await res.text().catch(() => "")
  return { kind: "error", status: res.status, message: text }
}

/**
 * POST .../settings/count-structural/reset-project-overrides — put every
 * project in the org back on the org's structural-cell default.
 *
 * Clears the per-project key rather than stamping the current value into each
 * one, so those projects follow the NEXT change of the default too.
 */
export async function resetCountStructuralOverrides(
  jwt: string,
  orgId: number,
  apiUrl: string = FRONTIER_API_URL,
): Promise<{ kind: "ok"; cleared: number } | { kind: "error"; message: string }> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/orgs/${orgId}/settings/count-structural/reset-project-overrides`,
      { method: "POST", headers: authHeaders(jwt) },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      return { kind: "error", message: body?.error ?? `HTTP ${res.status}` }
    }
    const body = (await res.json()) as { cleared: number }
    return { kind: "ok", cleared: Number(body.cleared) || 0 }
  } catch (err) {
    return { kind: "error", message: String(err) }
  }
}
