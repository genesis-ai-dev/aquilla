// AQU-1750: the settings write and the lane read wall.
//
// Behind the wall (LANE_READ_WALL on), a caller below Maintainer reads a
// FILTERED settings blob: ungranted lanes are gone from targetLanes and
// archivedLanes, and targetLanguage is "" unless the default lane is granted.
// useProjectSettings then writes `{ ...thatRead, ...edit }` back, and the route
// stores the blob whole. So every save by such a caller used to echo the
// filter's holes into the stored row: the project's primary target language and
// every lane the caller could not see were deleted for everyone. A
// language-only diff is admitted at the org's languageEditMinRole, so the
// write was allowed.
//
// The rule this pins: a caller cannot change what it cannot see. The route puts
// the stored hidden parts back before it diffs and saves, refuses an explicit
// replacement of a hidden primary language, and filters every body it returns
// (200 and 409) exactly as the GET does.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** French is the default lane. German is archived. dan and carla are granted
 *  Spanish only, so the read wall hides French and German from them. */
const STORED = {
  sourceLanguage: "English",
  targetLanguage: "French",
  targetLanes: ["de", "es"],
  archivedLanes: ["de"],
  systemPrompt: "Keep the register formal.",
}

const SEED = [{ srcToken: "father", tgtToken: "padre", weight: 1 }]

/**
 * alice owns the org (700). dan (500) and erin (500) are project leads; carla
 * (400) is a contributor. The org lowered languageEditMinRole to 500, so a
 * lead's language-only write is admitted. dan and carla hold a grant on the
 * Spanish lane; erin holds none.
 */
async function seed(): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(3, "carla")
  await seedUser(4, "dan")
  await seedUser(5, "erin")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_settings (org_id, settings, version, updated_by)
     VALUES (1, '{"languageEditMinRole":500}', 0, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Psalms', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES ('p1', 3, 400, 1), ('p1', 4, 500, 1), ('p1', 5, 500, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', 'p1', 'source', 'English', 'en', NULL, 0),
      ('ln-main', 'p1', 'target', 'French', 'fr', '', 1),
      ('ln-de', 'p1', 'target', 'German', 'de', 'de', 2),
      ('ln-es', 'p1', 'target', 'Spanish', 'es', 'es', 3)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level)
     VALUES ('p1', 4, 'ln-es', 500), ('p1', 3, 'ln-es', 400)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(STORED))
    .run()
}

interface SettingsBody {
  version: number
  settings: Record<string, unknown>
  lanes?: Array<{ id: string; role: string }>
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

async function getSettings(username: string): Promise<SettingsBody> {
  const res = await app.request(
    "/api/v2/projects/p1/settings",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  return (await res.json()) as SettingsBody
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

/** What useProjectSettings sends: the caller's own GET with one edit on top. */
async function echoWrite(username: string, edit: Record<string, unknown>): Promise<Response> {
  const seen = await getSettings(username)
  return patchSettings(username, { ...seen.settings, ...edit }, seen.version)
}

function targetLaneIds(body: SettingsBody): string[] {
  return (body.lanes ?? []).filter((lane) => lane.role === "target").map((lane) => lane.id)
}

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("settings writes behind the lane read wall (AQU-1750)", () => {
  it("the filtered read a lead's client echoes back really does lack the hidden lanes and primary", async () => {
    // The premise of every test below. If the GET stops filtering, these
    // writes stop being echoes of a filtered read and prove nothing.
    await seed()
    env.LANE_READ_WALL = "1"
    const seen = await getSettings("dan")
    expect(seen.settings.targetLanguage).toBe("")
    expect(seen.settings.targetLanes).toEqual(["es"])
    expect(seen.settings.archivedLanes).toEqual([])
    expect(targetLaneIds(seen)).toEqual(["ln-es"])
  })

  it.each([
    ["dan", "a grant on one lane"],
    ["erin", "no lane grants"],
  ])("a source-language edit by a lead with %s (%s) keeps the lanes and primary it cannot see", async (username) => {
    // The reported data loss: Project Info saves the whole echoed blob, and the
    // language-only diff is admitted at languageEditMinRole 500.
    await seed()
    env.LANE_READ_WALL = "1"
    const res = await echoWrite(username, { sourceLanguage: "Hebrew" })
    expect(res.status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, sourceLanguage: "Hebrew" })
  })

  it("a lead still removes and adds the lanes it can see", async () => {
    // Restoring hidden entries must not freeze the caller's own lanes.
    await seed()
    env.LANE_READ_WALL = "1"
    expect((await echoWrite("dan", { targetLanes: [] })).status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, targetLanes: ["de"] })

    expect((await echoWrite("dan", { targetLanes: ["Italian"] })).status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, targetLanes: ["de", "Italian"] })
  })

  it("a lead cannot replace a primary language it cannot see", async () => {
    // dan sees "" and may take the project for a source-only one. Setting a
    // primary here would overwrite French without dan ever having seen it, so
    // the write is refused rather than dropped without a word.
    await seed()
    env.LANE_READ_WALL = "1"
    const res = await echoWrite("dan", { targetLanguage: "Spanish" })
    expect(res.status).toBe(403)
    expect(await storedSettings()).toEqual(STORED)
  })

  it("a contributor's alignment-seed write is not refused because of the echo", async () => {
    // AQU-1408 admits an alignmentSeeds-only diff at Contributor. The filtered
    // echo used to add targetLanes/targetLanguage to the diff, so behind the
    // wall the carve-out answered 403 to everyone who could not see every lane.
    await seed()
    env.LANE_READ_WALL = "1"
    const res = await echoWrite("carla", { alignmentSeeds: SEED })
    expect(res.status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, alignmentSeeds: SEED })
  })

  it("the 200 body shows the caller what its GET would, not the restored row", async () => {
    // After the restore the stored row holds French and German again. The
    // response must not hand them to dan: the client keeps it as server truth.
    await seed()
    env.LANE_READ_WALL = "1"
    const res = await echoWrite("dan", { sourceLanguage: "Hebrew" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SettingsBody
    expect(body.settings).toEqual({ ...(await getSettings("dan")).settings })
    expect(body.settings.targetLanguage).toBe("")
    expect(body.settings.targetLanes).toEqual(["es"])
    expect(targetLaneIds(body)).toEqual(["ln-es"])
  })

  it("the 409 body is filtered like the GET, and the retry built on it loses nothing", async () => {
    // useProjectSettings stores a 409's `current` as server truth, so an
    // unfiltered body puts the hidden lanes and primary on dan's screen. It
    // then retries with `{ ...current.settings, ...edit }`, which is an echo
    // of a filtered row just like the GET path.
    await seed()
    env.LANE_READ_WALL = "1"
    const seen = await getSettings("dan")
    const edit = { sourceLanguage: "Hebrew" }
    const res = await patchSettings("dan", { ...seen.settings, ...edit }, 0)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { current: SettingsBody }
    expect(body.current.settings.targetLanguage).toBe("")
    expect(body.current.settings.targetLanes).toEqual(["es"])
    expect(body.current.settings.archivedLanes).toEqual([])
    expect(targetLaneIds(body.current)).toEqual(["ln-es"])
    expect(await storedSettings()).toEqual(STORED)

    const retry = await patchSettings("dan", { ...body.current.settings, ...edit }, body.current.version)
    expect(retry.status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, ...edit })
  })

  it("a maintainer still sees and writes every lane", async () => {
    // The wall does not apply at Maintainer+, so nothing is restored: the
    // owner may delete a lane dan cannot see.
    await seed()
    env.LANE_READ_WALL = "1"
    const res = await echoWrite("alice", { targetLanes: ["es"] })
    expect(res.status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, targetLanes: ["es"] })
    const body = (await res.json()) as SettingsBody
    expect(body.settings.targetLanguage).toBe("French")
  })

  it("with the wall off, a lead sees and may remove every lane", async () => {
    // Local and e2e run without the wall. Nothing is hidden there, so nothing
    // may be restored.
    await seed()
    const res = await echoWrite("dan", { targetLanes: ["es"] })
    expect(res.status).toBe(200)
    expect(await storedSettings()).toEqual({ ...STORED, targetLanes: ["es"] })
  })
})
