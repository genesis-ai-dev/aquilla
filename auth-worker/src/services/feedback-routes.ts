// Email routes for "Report a problem". A platform admin adds a route in the
// admin console: an org, optionally some of its projects, and the inboxes that
// should hear about reports from there. routes/feedback.ts asks this module who
// to email after it has posted to Discord.
//
// Matching, with the org and project the server resolved for the report:
//   - a project: routes for that org that cover the whole org or list the project
//   - an org but no project (an org page): whole-org routes for that org
//   - neither: whole-org routes for every org the reporter belongs to, so a
//     user stuck on the home page still reaches their org's inbox
// Project-scoped routes never match without a project.

import type { Env } from "../types"
import { sendFeedbackRouteEmail, type FeedbackRouteEmail } from "./email"
import type { FeedbackAttachment } from "./discord-feedback"

export const FEEDBACK_ROUTE_MAX_EMAILS = 10

export interface FeedbackRoute {
  id: number
  orgId: number
  /** Empty = the whole org. */
  projectIds: string[]
  emails: string[]
  label: string | null
  enabled: boolean
}

interface FeedbackRouteRow {
  id: number | string
  org_id: number | string
  project_ids: string | null
  emails: string
  label: string | null
  enabled: boolean
}

/** Read a JSON column holding a string array. Anything else is an empty list. */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

export function rowToRoute(row: FeedbackRouteRow): FeedbackRoute {
  return {
    id: Number(row.id),
    orgId: Number(row.org_id),
    projectIds: parseStringArray(row.project_ids),
    emails: parseStringArray(row.emails),
    label: row.label,
    enabled: row.enabled,
  }
}

/**
 * Pick the routes a report matches. Pure so the rules can be tested without a
 * database. `memberOrgIds` is only read when the report has no org.
 */
export function selectMatchingRoutes(
  routes: readonly FeedbackRoute[],
  ctx: { orgId: number | null; projectId: string | null; memberOrgIds: readonly number[] },
): FeedbackRoute[] {
  const live = routes.filter((r) => r.enabled)
  if (ctx.orgId !== null) {
    return live.filter(
      (r) =>
        r.orgId === ctx.orgId &&
        (r.projectIds.length === 0 || (ctx.projectId !== null && r.projectIds.includes(ctx.projectId))),
    )
  }
  const orgs = new Set(ctx.memberOrgIds)
  return live.filter((r) => r.projectIds.length === 0 && orgs.has(r.orgId))
}

/** Every address on the matched routes, once each (case-insensitive). */
export function collectRecipients(routes: readonly FeedbackRoute[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const route of routes) {
    for (const email of route.emails) {
      const key = email.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(email.trim())
    }
  }
  return out
}

/** Look up the routes a report matches. Throws on a database error. */
export async function findMatchingFeedbackRoutes(
  env: Env,
  ctx: { orgId: number | null; projectId: string | null; userId: number },
): Promise<FeedbackRoute[]> {
  const db = env.AQUILLA_PG
  let memberOrgIds: number[] = []
  if (ctx.orgId === null) {
    const { results } = await db
      .prepare("SELECT org_id FROM org_members WHERE user_id = ?")
      .bind(ctx.userId)
      .all<{ org_id: number | string }>()
    memberOrgIds = (results ?? []).map((r) => Number(r.org_id))
    if (memberOrgIds.length === 0) return []
  }
  const orgIds = ctx.orgId !== null ? [ctx.orgId] : memberOrgIds
  const { results } = await db
    .prepare(
      `SELECT id, org_id, project_ids, emails, label, enabled FROM feedback_routes
        WHERE enabled = true AND org_id IN (${orgIds.map(() => "?").join(", ")})`,
    )
    .bind(...orgIds)
    .all<FeedbackRouteRow>()
  return selectMatchingRoutes((results ?? []).map(rowToRoute), { ...ctx, memberOrgIds })
}

/**
 * Email a report to every matching route. Never throws: a failure here must
 * not cost the user their report or the Discord post. Resolves to the number
 * of addresses mailed, 0 when nothing matched or the send failed.
 */
export async function emailFeedbackRoutes(
  env: Env,
  ctx: { orgId: number | null; projectId: string | null; userId: number },
  report: Omit<FeedbackRouteEmail, "displayName">,
  screenshot: FeedbackAttachment | null,
): Promise<number> {
  try {
    const routes = await findMatchingFeedbackRoutes(env, ctx)
    const recipients = collectRecipients(routes)
    if (recipients.length === 0) return 0
    const row = await env.AQUILLA_PG.prepare("SELECT display_name FROM users WHERE id = ?")
      .bind(ctx.userId)
      .first<{ display_name: string | null }>()
    const sent = await sendFeedbackRouteEmail(
      env,
      recipients,
      { ...report, displayName: row?.display_name ?? null },
      screenshot,
    )
    return sent ? recipients.length : 0
  } catch (err) {
    console.warn("[feedback-routes] could not email routes:", err)
    return 0
  }
}
