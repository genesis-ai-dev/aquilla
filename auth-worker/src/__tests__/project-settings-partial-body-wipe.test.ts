// AQU-1730: the settings write REPLACES the stored blob; it does not merge keys.
//
// That is the contract — `updateProjectSettingsShared` stores what it is
// handed, whole — and it is a loaded gun pointed at every caller. A caller
// that sends only the key it changed does not patch that key: it deletes
// every other setting the project has (system prompt, rules, validation
// policy, translation brief, TTS voices, …). Two live SPA callers did exactly
// that, which is what AQU-1730 reported. The fix is on the CALLER side — echo
// the blob the server last returned with one key swapped in — so the thing
// worth pinning on the server is the contract those callers must respect,
// because nothing in the route's own shape announces it.
//
// The rules pinned here:
//   1. A one-key body wipes the omitted keys. If this test ever goes green on
//      a merge instead, the route changed semantics and the echoing callers
//      (`patchAgentMode`, `useProjectSettings`) are carrying dead weight.
//   2. An echoed blob with one key swapped keeps everything. This is the shape
//      every caller must send, and `patchAgentMode` sends it.
//   3. A `targetLanes`-only body — the create dialog's old wipe — is refused
//      outright (400), not applied: lanes are rows, not settings (AQU-1595).
//      "Add as lane" now goes through the lane-create route instead.
//   4. A stale `ifMatchVersion` answers 409 with the CURRENT row attached, so
//      a retry rebuilds its echo on that row. `patchAgentMode`'s single retry
//      depends on this: rebuilding from its own stale read would write a
//      collaborator's concurrent save back out.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** Everything a project of any age actually carries, minus the lane keys. */
const STORED = {
  systemPrompt: "Keep the register formal.",
  rules: [{ id: "r1", text: "No contractions" }],
  validationCount: 2,
  translationBrief: { audience: "village readers" },
}

/** alice owns the org (700) — comfortably above the settings-write floor. */
async function seed(stored: Record<string, unknown> = STORED): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Blob', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(stored))
    .run()
}

async function patch(
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 1,
): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

const AGENT_MODE = { initiative: false, react: true, scope: "qa" }

describe("project settings: the write replaces the blob (AQU-1730)", () => {
  it("a one-key body deletes every other stored setting", async () => {
    await seed()
    const res = await patch("alice", { agentMode: AGENT_MODE })
    expect(res.status).toBe(200)
    const after = await storedSettings()
    expect(after.agentMode).toEqual(AGENT_MODE)
    // The whole point: these are gone, and no error said so.
    expect(after.systemPrompt).toBeUndefined()
    expect(after.rules).toBeUndefined()
    expect(after.validationCount).toBeUndefined()
    expect(after.translationBrief).toBeUndefined()
  })

  it("an echoed blob with one key swapped keeps every other setting", async () => {
    await seed()
    const res = await patch("alice", { ...STORED, agentMode: AGENT_MODE })
    expect(res.status).toBe(200)
    const after = await storedSettings()
    expect(after.agentMode).toEqual(AGENT_MODE)
    expect(after.systemPrompt).toBe(STORED.systemPrompt)
    expect(after.rules).toEqual(STORED.rules)
    expect(after.validationCount).toBe(STORED.validationCount)
    expect(after.translationBrief).toEqual(STORED.translationBrief)
  })

  it("refuses a targetLanes-only body instead of applying it as a wipe", async () => {
    await seed({ ...STORED, targetLanes: ["es"] })
    const res = await patch("alice", { targetLanes: ["es", "fr"] })
    expect(res.status).toBe(400)
    const after = await storedSettings()
    expect(after.targetLanes).toEqual(["es"])
    expect(after.systemPrompt).toBe(STORED.systemPrompt)
  })

  it("keeps the stored lane keys through an echo that omits them", async () => {
    // A caller echoing its GET has already dropped the lane keys (the client
    // omits them). The route copies the stored values back, so the echo is
    // not a lane wipe either.
    await seed({ ...STORED, targetLanes: ["es"], targetLanguage: "Spanish" })
    const res = await patch("alice", { ...STORED, agentMode: AGENT_MODE })
    expect(res.status).toBe(200)
    const after = await storedSettings()
    expect(after.targetLanes).toEqual(["es"])
    expect(after.targetLanguage).toBe("Spanish")
    expect(after.agentMode).toEqual(AGENT_MODE)
  })

  it("409s a stale version with the current row attached, and a retry built on it loses nothing", async () => {
    await seed()
    // bob saves first. alice is still holding version 1.
    const first = await patch("bob", { ...STORED, systemPrompt: "Use plain speech." })
    expect(first.status).toBe(200)

    const stale = await patch("alice", { ...STORED, agentMode: AGENT_MODE }, 1)
    expect(stale.status).toBe(409)
    const body = (await stale.json()) as {
      current: { settings: Record<string, unknown>; version: number }
    }
    // The 409 carries bob's save, not alice's stale read — this is what the
    // retry must rebuild on.
    expect(body.current.settings.systemPrompt).toBe("Use plain speech.")
    expect(body.current.version).toBeGreaterThan(1)

    const retry = await patch(
      "alice",
      { ...body.current.settings, agentMode: AGENT_MODE },
      body.current.version,
    )
    expect(retry.status).toBe(200)
    const after = await storedSettings()
    expect(after.agentMode).toEqual(AGENT_MODE)
    // bob's concurrent save survived the retry.
    expect(after.systemPrompt).toBe("Use plain speech.")
    expect(after.rules).toEqual(STORED.rules)
  })
})
