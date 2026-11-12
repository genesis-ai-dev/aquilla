/**
 * AQU-1352 attack-suite helpers: run HTTP attacks against the auth-worker app
 * under an explicit ACCESS_GRANTS_RESOLVER mode, on top of the shared access
 * fixture (helpers/access-fixture.ts).
 */

import { env } from "cloudflare:test"
import app from "../../index"
import { authHeader, jwtFor, seedUser } from "./db"
import type { Env } from "../../types"

export const RESOLVER_MODES = ["off", "on"] as const
export type ResolverMode = (typeof RESOLVER_MODES)[number]

export function envFor(mode: ResolverMode): Env {
  return { ...(env as unknown as Env), ACCESS_GRANTS_RESOLVER: mode }
}

// Routes that fire best-effort notifications call c.executionCtx.waitUntil.
const testCtx = {
  waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext

export async function req(
  mode: ResolverMode,
  username: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await app.request(
    path,
    {
      method: init.method ?? "GET",
      headers: authHeader(await jwtFor(username)),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    envFor(mode),
    testCtx,
  )
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json }
}

export async function sql(query: string, ...binds: unknown[]): Promise<void> {
  await env.AQUILLA_PG.prepare(query).bind(...binds).run()
}

export async function count(query: string, ...binds: unknown[]): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(query).bind(...binds).first<{ n: number | string }>()
  return Number(row?.n ?? 0)
}

/**
 * Extra fixture user 12 "team_lead": org Contributor-below (300) whose only
 * project path is team 3 "fixture/p1-leads" (team role 500) attached to p1 at
 * 500. A team-scoped Project Lead on p1 and nothing else.
 */
export const TEAM_LEAD = { id: 12, name: "team_lead", teamId: 3, teamName: "fixture/p1-leads" } as const

export async function seedTeamLead(): Promise<void> {
  await seedUser(TEAM_LEAD.id, TEAM_LEAD.name)
  await sql(`INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 12, 300, 1)`)
  await sql(`INSERT INTO groups (id, org_id, name, created_by) VALUES (3, 1, 'fixture/p1-leads', 1)`)
  await sql(`INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (3, 12, 1, 500)`)
  await sql(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (3, 'p1', 500, 1)`,
  )
}
