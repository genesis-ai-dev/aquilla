// AQU-1943 — the ceiling on `ttsSettings` at the human settings write.
//
// Every member re-reads this blob on workspace open and on window focus, so a
// runaway voice library is a whole-project outage, not one person's mess: a
// production project reached 5.45 MB / 31,287 voices and the Voices panel died
// on open (AQU-1940). AQU-1941 prunes the known damage; this closes the door
// on every writer of the library — and must still let an already-over project
// save the rest of its settings, and write the prune itself.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  MAX_TTS_CAST_ASSIGNMENTS,
  MAX_TTS_SETTINGS_BYTES,
  MAX_TTS_VOICES,
} from "../../../db/shared/tts-settings-caps"

async function seed(settings: Record<string, unknown> = {}) {
  await seedUser(1, "olive") // owner
  await seedUser(2, "mara") // maintainer
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'John', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version) VALUES ('p1', $1, 0)",
  ).bind(JSON.stringify(settings)).run()
}

const patchSettings = async (
  jwt: string,
  settings: Record<string, unknown>,
  ifMatchVersion = 0,
) =>
  app.request(
    "/api/v2/projects/p1/settings",
    { method: "PATCH", headers: authHeader(jwt), body: JSON.stringify({ settings, ifMatchVersion }) },
    env,
  )

const storedRow = async () => {
  const row = (await env.AQUILLA_PG
    .prepare("SELECT settings, version FROM project_settings WHERE project_id = 'p1'")
    .first<{ settings: string; version: number }>())!
  return { settings: JSON.parse(row.settings) as Record<string, unknown>, version: row.version }
}

const voices = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `v${i}`, name: `Voice ${i}` }))

const assignments = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, "v0"]))

describe("ttsSettings cap on the settings route", () => {
  it("422s one voice over the cap, naming the limit and the count, and stores nothing", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("mara"), {
      ttsSettings: { voices: voices(MAX_TTS_VOICES + 1) },
    })
    expect(res.status).toBe(422)
    const { error } = await res.json() as { error: string }
    expect(error).toContain(String(MAX_TTS_VOICES + 1))
    expect(error).toContain(String(MAX_TTS_VOICES))
    // The write never happened: neither the blob nor the version moved, so a
    // client that keeps the version from its last read is still in step.
    const after = await storedRow()
    expect(after.settings.ttsSettings).toBeUndefined()
    expect(after.version).toBe(0)
  })

  it("stores a library at exactly the cap", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("mara"), {
      ttsSettings: { voices: voices(MAX_TTS_VOICES) },
    })
    expect(res.status).toBe(200)
    const after = await storedRow()
    expect((after.settings.ttsSettings as { voices: unknown[] }).voices).toHaveLength(MAX_TTS_VOICES)
  })

  it("422s one byte over the serialized-size cap", async () => {
    await seed()
    const padded = { voices: [{ id: "v0", name: "x".repeat(MAX_TTS_SETTINGS_BYTES) }] }
    expect(JSON.stringify(padded).length).toBeGreaterThan(MAX_TTS_SETTINGS_BYTES)
    const res = await patchSettings(await jwtFor("mara"), { ttsSettings: padded })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toContain(String(MAX_TTS_SETTINGS_BYTES))
    expect((await storedRow()).settings.ttsSettings).toBeUndefined()
  })

  it("422s one cast assignment over the cap", async () => {
    await seed()
    const res = await patchSettings(await jwtFor("mara"), {
      ttsSettings: { voices: voices(1), castAssignments: assignments(MAX_TTS_CAST_ASSIGNMENTS + 1) },
    })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toContain(String(MAX_TTS_CAST_ASSIGNMENTS))
    expect((await storedRow()).settings.ttsSettings).toBeUndefined()
  })

  it("lets a project already over the cap save its other settings, and refuses further growth", async () => {
    const over = { voices: voices(MAX_TTS_VOICES + 500) }
    await seed({ ttsSettings: over })
    // The SPA sends the whole blob on every save: an unchanged over-cap value
    // rides along so the project is not locked out of its own settings form.
    const echo = await patchSettings(await jwtFor("mara"), {
      ttsSettings: over,
      systemPrompt: "Keep it plain.",
    })
    expect(echo.status).toBe(200)
    expect((await storedRow()).settings.systemPrompt).toBe("Keep it plain.")

    // One more voice on top of it is refused — over-cap is not a licence to grow.
    const grown = await patchSettings(
      await jwtFor("mara"),
      { ttsSettings: { voices: voices(MAX_TTS_VOICES + 501) }, systemPrompt: "Keep it plain." },
      1,
    )
    expect(grown.status).toBe(422)
    expect((await storedRow()).version).toBe(1)
  })

  it("accepts the prune that brings an over-cap project back under", async () => {
    await seed({ ttsSettings: { voices: voices(MAX_TTS_VOICES + 500) } })
    const res = await patchSettings(await jwtFor("mara"), {
      ttsSettings: { voices: voices(12) },
    })
    expect(res.status).toBe(200)
    expect((await storedRow()).settings.ttsSettings).toEqual({ voices: voices(12) })
  })
})
