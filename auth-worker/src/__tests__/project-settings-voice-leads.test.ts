// AQU-2041: "Project leads can manage voices" is off until a maintainer turns
// it on. While it is on, a project lead may change voices on lanes they can
// write. A crafted change to a hidden lane is refused. Contributors and
// viewers never may, and a lead cannot flip the switch.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const TTS = {
  voices: [
    { id: "narrator", name: "Narrator" },
    { id: "es-1", name: "Spanish", laneId: "ln-es" },
    { id: "de-1", name: "German", laneId: "ln-de" },
  ],
  laneCastAssignments: { es: { guide: "es-1" }, de: { hero: "de-1" } },
  laneDefaultVoiceId: { es: "es-1", de: "de-1" },
}

function stored(flag: boolean): Record<string, unknown> {
  return {
    systemPrompt: "Formal.",
    ...(flag ? { projectLeadsManageVoices: true } : {}),
    ttsSettings: TTS,
  }
}

async function seed(flag: boolean): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(3, "carla")
  await seedUser(4, "dan")
  await seedUser(6, "vera")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Voices', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 3, 400, 1), ('p1', 4, 500, 1), ('p1', 6, 100, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-de', 'p1', 'target', 'German', 'de', 'de', 1),
      ('ln-es', 'p1', 'target', 'Spanish', 'es', 'es', 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level)
     VALUES ('p1', 4, 'ln-es', 500), ('p1', 3, 'ln-es', 400), ('p1', 6, 'ln-es', 100)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  ).bind(JSON.stringify(stored(flag))).run()
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

function splitOrigin(from: string): string {
  return JSON.stringify({ aquillaOrigin: { version: 1, kind: "user-insert", splitFrom: from } })
}

async function seedSplitPieces(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id, metadata)
     VALUES
       ('p1', 'f1', 'guide-b', 'source', 'b', 'e-guide-b', 1, (SELECT aquilla_test_resolve_source_lane('p1')), ?::text::jsonb),
       ('p1', 'f1', 'hero-b', 'source', 'b', 'e-hero-b', 1, (SELECT aquilla_test_resolve_source_lane('p1')), ?::text::jsonb)`,
  ).bind(splitOrigin("guide"), splitOrigin("hero")).run()
}

async function getSettings(username: string): Promise<{ version: number; settings: Record<string, unknown> }> {
  const res = await app.request(
    "/api/v2/projects/p1/settings",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { version: number; settings: Record<string, unknown> }
}

async function patchSettings(
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion: number,
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

function renameSpanish(settings: Record<string, unknown>, name: string): Record<string, unknown> {
  const tts = settings.ttsSettings as { voices: { id: string; name: string }[] }
  return {
    ...settings,
    ttsSettings: {
      ...tts,
      voices: tts.voices.map((voice) => (voice.id === "es-1" ? { ...voice, name } : voice)),
    },
  }
}

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("project leads managing voices (AQU-2041)", () => {
  it("refuses a lead, a contributor, and a viewer while the switch is off", async () => {
    await seed(false)
    env.LANE_READ_WALL = "1"
    for (const username of ["dan", "carla", "vera"]) {
      const seen = await getSettings(username)
      const res = await patchSettings(username, renameSpanish(seen.settings, "Español"), seen.version)
      expect(res.status).toBe(403)
    }
    expect(await storedSettings()).toEqual(stored(false))
  })

  it("lets a lead rename a voice on a lane they can write, and keeps the hidden lane", async () => {
    await seed(true)
    env.LANE_READ_WALL = "1"
    const seen = await getSettings("dan")
    expect(JSON.stringify(seen.settings.ttsSettings)).not.toContain("de-1")
    const res = await patchSettings("dan", renameSpanish(seen.settings, "Español"), seen.version)
    expect(res.status).toBe(200)
    const saved = await storedSettings()
    const tts = saved.ttsSettings as { voices: { id: string; name: string }[]; laneDefaultVoiceId: Record<string, string> }
    expect(tts.voices.find((voice) => voice.id === "es-1")?.name).toBe("Español")
    expect(tts.voices.find((voice) => voice.id === "de-1")?.name).toBe("German")
    expect(tts.laneDefaultVoiceId.de).toBe("de-1")
    expect(saved.projectLeadsManageVoices).toBe(true)
  })

  it("refuses a crafted change to a hidden lane's voice and leaves it stored", async () => {
    await seed(true)
    env.LANE_READ_WALL = "1"
    const seen = await getSettings("dan")
    const tts = structuredClone(TTS)
    tts.voices = tts.voices.map((voice) => (voice.id === "de-1" ? { ...voice, name: "Deutsch" } : voice))
    const res = await patchSettings("dan", { ...seen.settings, ttsSettings: tts }, seen.version)
    expect(res.status).toBe(403)
    expect(await storedSettings()).toEqual(stored(true))
  })

  it("refuses a lead turning the switch off, and a contributor saving while it is on", async () => {
    await seed(true)
    env.LANE_READ_WALL = "1"
    const lead = await getSettings("dan")
    const flip = await patchSettings("dan", { ...lead.settings, projectLeadsManageVoices: false }, lead.version)
    expect(flip.status).toBe(403)
    const contributor = await getSettings("carla")
    const save = await patchSettings("carla", renameSpanish(contributor.settings, "Español"), contributor.version)
    expect(save.status).toBe(403)
    expect(await storedSettings()).toEqual(stored(true))
  })

  it("copies every lane's cast onto the new narration pieces, including a lane the lead cannot see", async () => {
    await seed(false)
    await seedSplitPieces()
    env.LANE_READ_WALL = "1"
    const body = JSON.stringify({
      fileId: "f1",
      splits: [
        { cellId: "guide", sameKindAsFirst: ["guide-b"] },
        { cellId: "hero", sameKindAsFirst: ["hero-b"] },
      ],
    })
    const res = await app.request(
      "/api/v2/projects/p1/split-casts",
      { method: "POST", headers: authHeader(await jwtFor("dan")), body },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changed: true })
    const saved = await storedSettings()
    const lanes = (saved.ttsSettings as {
      laneCastAssignments: Record<string, Record<string, string>>
    }).laneCastAssignments
    expect(lanes.es).toEqual({ guide: "es-1", "guide-b": "es-1" })
    expect(lanes.de).toEqual({ hero: "de-1", "hero-b": "de-1" })
    const again = await app.request(
      "/api/v2/projects/p1/split-casts",
      { method: "POST", headers: authHeader(await jwtFor("dan")), body },
      env,
    )
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ changed: false })
    const denied = await app.request(
      "/api/v2/projects/p1/split-casts",
      { method: "POST", headers: authHeader(await jwtFor("carla")), body },
      env,
    )
    expect(denied.status).toBe(403)
    expect(await storedSettings()).toEqual(saved)
  })

  it("copies a character's voice when the row has no entry of its own", async () => {
    await seed(false)
    await seedSplitPieces()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, lane_id, metadata)
       VALUES ('p1', 'f1', 'guide', 'source', 'a', 'e-guide', 1, (SELECT aquilla_test_resolve_source_lane('p1')), ?::text::jsonb)`,
    ).bind(JSON.stringify({ cast_name: "Guide" })).run()
    const settings = await storedSettings()
    const tts = settings.ttsSettings as {
      laneCastAssignments: Record<string, Record<string, string>>
      castAssignments?: Record<string, string>
    }
    tts.castAssignments = { "character:Guide": "narrator" }
    tts.laneCastAssignments = {
      ...tts.laneCastAssignments,
      es: { "character:Guide": "es-1" },
    }
    await env.AQUILLA_PG.prepare(
      "UPDATE project_settings SET settings = ? WHERE project_id = 'p1'",
    ).bind(JSON.stringify(settings)).run()
    env.LANE_READ_WALL = "1"
    const res = await app.request(
      "/api/v2/projects/p1/split-casts",
      {
        method: "POST",
        headers: authHeader(await jwtFor("dan")),
        body: JSON.stringify({
          fileId: "f1",
          splits: [{ cellId: "guide", sameKindAsFirst: ["guide-b"], castName: "Someone Else" }],
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changed: true })
    const saved = await storedSettings()
    const savedTts = saved.ttsSettings as {
      castAssignments: Record<string, string>
      laneCastAssignments: Record<string, Record<string, string>>
    }
    expect(savedTts.castAssignments["guide-b"]).toBe("narrator")
    expect(savedTts.laneCastAssignments.es["guide-b"]).toBe("es-1")
    expect(savedTts.laneCastAssignments.de).toEqual({ hero: "de-1" })
  })

  it("refuses a cell that was not split from the named row, and leaves the cast alone", async () => {
    await seed(false)
    await seedSplitPieces()
    env.LANE_READ_WALL = "1"
    const before = await storedSettings()
    const forged = await app.request(
      "/api/v2/projects/p1/split-casts",
      {
        method: "POST",
        headers: authHeader(await jwtFor("dan")),
        body: JSON.stringify({
          fileId: "f1",
          splits: [{ cellId: "guide", sameKindAsFirst: ["guide-b", "other"] }],
        }),
      },
      env,
    )
    expect(forged.status).toBe(422)
    const wrongParent = await app.request(
      "/api/v2/projects/p1/split-casts",
      {
        method: "POST",
        headers: authHeader(await jwtFor("dan")),
        body: JSON.stringify({
          fileId: "f1",
          splits: [{ cellId: "guide", sameKindAsFirst: ["hero-b"] }],
        }),
      },
      env,
    )
    expect(wrongParent.status).toBe(422)
    expect(await storedSettings()).toEqual(before)
  })

  it("lets a maintainer turn the switch off", async () => {
    await seed(true)
    env.LANE_READ_WALL = "1"
    const seen = await getSettings("alice")
    const res = await patchSettings("alice", { ...seen.settings, projectLeadsManageVoices: false }, seen.version)
    expect(res.status).toBe(200)
    expect((await storedSettings()).projectLeadsManageVoices).toBe(false)
  })
})
