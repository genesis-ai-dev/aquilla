import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { readOrgBillingOverrides, writeOrgBillingOverrides } from "../lib/billing/words"

// AQU-2328: the billing overrides live inside the organization's settings
// row, so saving them must bump and check `version` like every other
// org_settings writer. Otherwise a settings save that read the row before the
// billing save puts the old overrides back, and a billing save that read the
// row before a settings save puts the old settings back. Both silently.

async function seedOrg() {
  await seedUser(7, "root")
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
}

type SettingsBody = { version: number; settings: Record<string, unknown> }

const getSettings = async (): Promise<SettingsBody> => {
  const res = await app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor("wendi")) }, env)
  expect(res.status).toBe(200)
  return (await res.json()) as SettingsBody
}

const putSettings = async (settings: Record<string, unknown>, ifMatchVersion: number) =>
  app.request("/api/v2/orgs/1/settings", {
    method: "PUT",
    headers: authHeader(await jwtFor("wendi")),
    body: JSON.stringify({ settings, ifMatchVersion }),
  }, env)

const saveBillingOverrides = async (patch: { includedCredits?: number | null; billedLanguageCount?: number | null }) =>
  app.request("/api/v2/admin/billing/org/1", {
    method: "PATCH",
    headers: authHeader(await jwtFor("root")),
    body: JSON.stringify(patch),
  }, env)

const storedRow = async () =>
  env.AQUILLA_PG.prepare("SELECT settings, version FROM org_settings WHERE org_id = 1")
    .first<{ settings: string; version: number }>()

/**
 * The database, with `between` run once just before the billing writer's
 * first write to org_settings: a settings save that lands after the billing
 * writer read the row and before it wrote it back.
 */
function withSaveBetweenReadAndWrite(between: () => Promise<void>): typeof env.AQUILLA_PG {
  const db = env.AQUILLA_PG
  let fired = false
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver)
      return (sql: string) => {
        const stmt = target.prepare(sql)
        if (!/^\s*(INSERT INTO|UPDATE)\s+org_settings\b/i.test(sql)) return stmt
        return new Proxy(stmt, {
          get(s, p, r) {
            if (p !== "bind") return Reflect.get(s, p, r)
            return (...args: unknown[]) => {
              const bound = s.bind(...args)
              return new Proxy(bound, {
                get(b, q, rr) {
                  if (q !== "run") return Reflect.get(b, q, rr)
                  return async () => {
                    if (!fired) {
                      fired = true
                      await between()
                    }
                    return b.run()
                  }
                },
              })
            }
          },
        })
      }
    },
  })
}

describe("AQU-2328: saving billing overrides bumps and checks the settings version", () => {
  it("a settings save that read the row before a billing save is refused, and the overrides stay", async () => {
    await seedOrg()
    const first = await putSettings({ rules: [] }, 0)
    expect(first.status).toBe(200)

    // Someone opens the organization's settings...
    const opened = await getSettings()
    expect(opened.version).toBe(1)

    // ...an operator saves billing overrides...
    const billing = await saveBillingOverrides({ includedCredits: 40, billedLanguageCount: 3 })
    expect(billing.status).toBe(200)

    // ...and the first person saves their older copy.
    const stale = await putSettings({ ...opened.settings, countStructuralCells: true }, opened.version)
    expect(stale.status).toBe(409)

    expect(await readOrgBillingOverrides(env.AQUILLA_PG, 1)).toEqual({ includedCredits: 40, billedLanguageCount: 3 })
    expect((await getSettings()).version).toBe(2)
  })

  it("a settings save that lands between the billing writer's read and write is kept", async () => {
    await seedOrg()
    expect((await putSettings({ rules: [] }, 0)).status).toBe(200)

    const racing = withSaveBetweenReadAndWrite(async () => {
      const opened = await getSettings()
      const res = await putSettings({ ...opened.settings, countStructuralCells: true }, opened.version)
      expect(res.status).toBe(200)
    })
    await writeOrgBillingOverrides(racing, 1, { includedCredits: 40 })

    const row = await storedRow()
    const settings = JSON.parse(row!.settings) as Record<string, unknown>
    expect(settings.countStructuralCells).toBe(true)
    expect(settings.billing).toEqual({ includedCredits: 40 })
    expect(row!.version).toBe(3)
  })

  it("a first settings save that lands before the billing writer creates the row is kept", async () => {
    await seedOrg()
    // No org_settings row yet: the billing writer will create it.
    expect(await storedRow()).toBeNull()

    const racing = withSaveBetweenReadAndWrite(async () => {
      const res = await putSettings({ countStructuralCells: true }, 0)
      expect(res.status).toBe(200)
    })
    await writeOrgBillingOverrides(racing, 1, { billedLanguageCount: 2 })

    const row = await storedRow()
    const settings = JSON.parse(row!.settings) as Record<string, unknown>
    expect(settings.countStructuralCells).toBe(true)
    expect(settings.billing).toEqual({ billedLanguageCount: 2 })
    expect(row!.version).toBe(2)
  })
})
