// AQU-538 slice 4: sibling-merge route tests (routes/merge-sibling.ts).
//
// Covers the identity-side gate + orchestration with the sync-worker fold
// mocked at the fetch boundary:
//   - role floor: 403 when below project_lead (500) on EITHER project;
//   - validation errors: duplicate lane, archived donor, downstreams present;
//   - success path: fold called with the right shape, lane registered on the
//     host, donor archived + pointed at the host.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { laneDisplayName, laneLanguageCode } from "../../../src/lib/lanes/lane-display"

async function seedProject(projectId: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, name, createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

async function settingsOf(projectId: string): Promise<{ settings: Record<string, unknown>; version: number } | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings, version FROM project_settings WHERE project_id = ?",
  )
    .bind(projectId)
    .first<{ settings: string; version: number }>()
  if (!row) return null
  return { settings: JSON.parse(row.settings) as Record<string, unknown>, version: Number(row.version) }
}

function mockFold(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

async function post(hostId: string, jwt: string, payload: Record<string, unknown>) {
  return app.request(
    `/api/v2/projects/${hostId}/merge-sibling`,
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify(payload) },
    env,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("POST /:projectId/merge-sibling — role floors", () => {
  it("403 when the caller is below project_lead on the HOST", async () => {
    await seedUser(1, "u1")
    await seedProject("host-a", "Host", 99) // someone else created it
    await seedProject("donor-a", "Donor", 1)
    await grant("host-a", 1, 400) // contributor on host
    await grant("donor-a", 1, 500)

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "fr" })
    const res = await post("host-a", await jwtFor("u1"), { donorProjectId: "donor-a", lane: "fr" })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("403 when the caller is below project_lead on the DONOR", async () => {
    await seedUser(2, "u2")
    await seedProject("host-b", "Host", 2)
    await seedProject("donor-b", "Donor", 99)
    await grant("host-b", 2, 500)
    await grant("donor-b", 2, 300) // reviewer on donor

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "fr" })
    const res = await post("host-b", await jwtFor("u2"), { donorProjectId: "donor-b", lane: "fr" })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("POST /:projectId/merge-sibling — validation", () => {
  it("accepts a lane of a language the host already has under another tag", async () => {
    await seedUser(31, "u31")
    await seedProject("host-lang", "Host", 31)
    await seedProject("donor-lang", "Donor", 31)
    await grant("host-lang", 31, 500)
    await grant("donor-lang", 31, 500)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, ?)",
    )
      .bind("host-lang", JSON.stringify({ targetLanes: ["Spanish"] }), 31)
      .run()

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "es" })
    const res = await post("host-lang", await jwtFor("u31"), { donorProjectId: "donor-lang", lane: "es" })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it("400 when the lane already exists on the host", async () => {
    await seedUser(3, "u3")
    await seedProject("host-c", "Host", 3)
    await seedProject("donor-c", "Donor", 3)
    await grant("host-c", 3, 500)
    await grant("donor-c", 3, 500)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, ?)",
    )
      .bind("host-c", JSON.stringify({ targetLanes: ["fr"] }), 3)
      .run()

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "fr" })
    const res = await post("host-c", await jwtFor("u3"), { donorProjectId: "donor-c", lane: "fr" })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("400 when the donor is archived", async () => {
    await seedUser(4, "u4")
    await seedProject("host-d", "Host", 4)
    await seedProject("donor-d", "Donor", 4)
    await grant("host-d", 4, 500)
    await grant("donor-d", 4, 500)
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind("donor-d")
      .run()

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "fr" })
    // Archived donor → resolveProjectRole returns null → 403 (no access) is
    // acceptable, but the archived check also 400s; either way the fold is not
    // called and nothing is mutated. We assert the fold never ran.
    const res = await post("host-d", await jwtFor("u4"), { donorProjectId: "donor-d", lane: "fr" })
    expect([400, 403]).toContain(res.status)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("400 when the donor has downstream links", async () => {
    await seedUser(5, "u5")
    await seedProject("host-e", "Host", 5)
    await seedProject("donor-e", "Donor", 5)
    await seedProject("child-e", "Child", 5)
    await grant("host-e", 5, 500)
    await grant("donor-e", 5, 500)
    // child-e reads from donor-e.
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_project_id = ? WHERE id = ?")
      .bind("donor-e", "child-e")
      .run()

    const fetchSpy = mockFold({ merged: 0, skipped: [], lane: "fr" })
    const res = await post("host-e", await jwtFor("u5"), { donorProjectId: "donor-e", lane: "fr" })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("400 when donor === host", async () => {
    await seedUser(6, "u6")
    await seedProject("host-f", "Host", 6)
    await grant("host-f", 6, 500)

    const res = await post("host-f", await jwtFor("u6"), { donorProjectId: "host-f", lane: "fr" })
    expect(res.status).toBe(400)
  })
})

describe("POST /:projectId/merge-sibling — success path", () => {
  it("folds, registers the lane on the host, archives + points the donor", async () => {
    await seedUser(7, "u7")
    await seedProject("host-g", "Host", 7)
    await seedProject("donor-g", "Donor", 7)
    await grant("host-g", 7, 500)
    await grant("donor-g", 7, 500)

    const fetchSpy = mockFold({
      merged: 3,
      skipped: [{ cellId: "x", preview: "orphan" }],
      lane: "swh",
    })

    const res = await post("host-g", await jwtFor("u7"), { donorProjectId: "donor-g", lane: " swh " })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      lane: string
      merged: number
      skipped: unknown[]
      actions: Record<string, boolean>
    }
    expect(body.lane).toBe("swh") // trimmed
    expect(body.merged).toBe(3)
    expect(body.skipped).toHaveLength(1)
    expect(body.actions).toEqual({
      laneRegistered: true,
      donorArchived: true,
      donorPointerWritten: true,
    })

    // Fold called with the trimmed lane + donor id, to the host's fold route.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchSpy.mock.calls[0]!
    expect(String(calledUrl)).toContain("/api/v1/projects/host-g/merge-sibling")
    const sent = JSON.parse(String((init as RequestInit).body)) as { donorProjectId: string; lane: string }
    expect(sent).toEqual({ donorProjectId: "donor-g", lane: "swh" })

    // Lane registered on the host settings.
    const host = await settingsOf("host-g")
    expect(readLanes(host?.settings)).toEqual(["swh"])

    // Donor archived + carries the merge pointer.
    const donorRow = await env.AQUILLA_PG.prepare(
      "SELECT archived_at FROM projects WHERE id = ?",
    )
      .bind("donor-g")
      .first<{ archived_at: string | null }>()
    expect(donorRow?.archived_at).not.toBeNull()

    const donor = await settingsOf("donor-g")
    expect(donor?.settings.mergedInto).toBe("host-g")
    expect(donor?.settings.mergedLane).toBe("swh")
  })

  it("appends to existing host lanes rather than replacing them", async () => {
    await seedUser(8, "u8")
    await seedProject("host-h", "Host", 8)
    await seedProject("donor-h", "Donor", 8)
    await grant("host-h", 8, 500)
    await grant("donor-h", 8, 500)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 2, ?)",
    )
      .bind("host-h", JSON.stringify({ targetLanes: ["fr"], sourceLanguage: "en" }), 8)
      .run()

    mockFold({ merged: 1, skipped: [], lane: "swh" })
    const res = await post("host-h", await jwtFor("u8"), { donorProjectId: "donor-h", lane: "swh" })
    expect(res.status).toBe(200)

    const host = await settingsOf("host-h")
    expect(readLanes(host?.settings)).toEqual(["fr", "swh"])
    // Unrelated settings preserved, version bumped.
    expect(host?.settings.sourceLanguage).toBe("en")
    expect(host?.version).toBe(3)
  })

  it("502 and no mutations when the fold fails", async () => {
    await seedUser(9, "u9")
    await seedProject("host-i", "Host", 9)
    await seedProject("donor-i", "Donor", 9)
    await grant("host-i", 9, 500)
    await grant("donor-i", 9, 500)

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
    const res = await post("host-i", await jwtFor("u9"), { donorProjectId: "donor-i", lane: "fr" })
    expect(res.status).toBe(502)

    // Nothing mutated: donor not archived, no lane registered.
    const donorRow = await env.AQUILLA_PG.prepare("SELECT archived_at FROM projects WHERE id = ?")
      .bind("donor-i")
      .first<{ archived_at: string | null }>()
    expect(donorRow?.archived_at).toBeNull()
    expect(await settingsOf("host-i")).toBeNull()
  })
})

// AQU-1550: the merged lane has to be a real lane — a `lanes` record, not just
// a tag in the host's settings. The fold (mocked here) creates the record with
// the rows it writes; this route registers the tag through the shared settings
// write, which keeps the two in step, and refuses a name the host already shows.
describe("POST /:projectId/merge-sibling — the lane is a real lane (AQU-1550)", () => {
  interface LaneRow {
    /** AQU-1592: the stored freeform language. */
    language: string | null
    /** AQU-1592: null when the lane carries only a language. */
    name: string | null
    role: string
    legacy_tag: string | null
    lang_code: string | null
  }

  async function lanesOf(projectId: string): Promise<LaneRow[]> {
    const { results } = await env.AQUILLA_PG.prepare(
      "SELECT language, name, role, legacy_tag, lang_code FROM lanes WHERE project_id = ? ORDER BY position, id",
    )
      .bind(projectId)
      .all<LaneRow>()
    return results
  }

  async function seedLane(
    projectId: string,
    lane: {
      id: string
      /** AQU-1592: the freeform language. Defaults to '' when the test only cares about the name. */
      language?: string
      /** Null when the lane carries only a language. */
      name: string | null
      legacyTag: string
      position: number
    },
  ): Promise<void> {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES (?, ?, 'target', ?, ?, NULL, ?, ?)",
    )
      .bind(lane.id, projectId, lane.language ?? "", lane.name, lane.legacyTag, lane.position)
      .run()
  }

  it("leaves the host with a lane record for the tag, even when the fold had nothing to write", async () => {
    await seedUser(10, "u10")
    await seedProject("host-j", "Host", 10)
    await seedProject("donor-j", "Donor", 10)
    await grant("host-j", 10, 500)
    await grant("donor-j", 10, 500)

    // merged: 0 — the fold wrote no rows, so it created no lane either.
    mockFold({ merged: 0, skipped: [], lane: "fr" })
    const res = await post("host-j", await jwtFor("u10"), { donorProjectId: "donor-j", lane: "fr" })
    expect(res.status).toBe(200)

    expect(readLanes((await settingsOf("host-j"))?.settings)).toEqual(["fr"])
    const lane = (await lanesOf("host-j")).find((row) => row.legacy_tag === "fr")
    // AQU-1592: the tag IS the lane's language — tags are language labels. No
    // derived name and no derived code are stored; laneDisplayName shows "fr"
    // and laneLanguageCode derives "fr" from it at read time.
    expect(lane).toEqual({
      language: "fr",
      name: null,
      role: "target",
      legacy_tag: "fr",
      lang_code: null,
    })
    expect(laneDisplayName({ role: "target", language: lane!.language, name: lane!.name })).toBe("fr")
    expect(
      laneLanguageCode({ language: lane!.language, name: lane!.name, langCode: lane!.lang_code }),
    ).toBe("fr")
  })

  it("400 and no fold when another of the host's lanes already shows that name", async () => {
    await seedUser(11, "u11")
    await seedProject("host-k", "Host", 11)
    await seedProject("donor-k", "Donor", 11)
    await grant("host-k", 11, 500)
    await grant("donor-k", 11, 500)
    // A lane added from the Languages screen: its tag is not its name.
    await seedLane("host-k", { id: "lane-k1", name: "French", legacyTag: "lane-k1", position: 2 })

    const fetchSpy = mockFold({ merged: 1, skipped: [], lane: "french" })
    const res = await post("host-k", await jwtFor("u11"), { donorProjectId: "donor-k", lane: "french" })

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await settingsOf("host-k")).toBeNull()
  })

  it("a retry goes ahead when an earlier attempt already created the lane record", async () => {
    await seedUser(12, "u12")
    await seedProject("host-l", "Host", 12)
    await seedProject("donor-l", "Donor", 12)
    await grant("host-l", 12, 500)
    await grant("donor-l", 12, 500)
    // The earlier fold wrote some rows (and so the record) and then failed: the
    // record exists, the tag was never registered.
    await seedLane("host-l", { id: "lane-l1", name: "fr", legacyTag: "fr", position: 2 })

    const fetchSpy = mockFold({ merged: 4, skipped: [], lane: "fr" })
    const res = await post("host-l", await jwtFor("u12"), { donorProjectId: "donor-l", lane: "fr" })

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(readLanes((await settingsOf("host-l"))?.settings)).toEqual(["fr"])
    // Still one record for the tag.
    expect((await lanesOf("host-l")).filter((row) => row.legacy_tag === "fr")).toHaveLength(1)
  })
})

// AQU-1550: the sync worker's fold endpoint re-checks the caller's live role on
// the donor (pen test 2026-09-29), so the service token has to say who the
// caller is. It used to carry `userId: 0`, which no project grants anything to
// — every merge through this route was refused with a 403 the fold mock here
// could never produce. The real two-worker call is covered end to end in
// e2e/specs/projects/merge-sibling.spec.ts; these pin the claims.
describe("POST /:projectId/merge-sibling — the fold token names the caller (AQU-1550)", () => {
  function foldTokenClaims(fetchSpy: ReturnType<typeof mockFold>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    const token = new Headers(init.headers).get("Authorization")!.replace(/^Bearer /, "")
    const payload = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(atob(payload)) as Record<string, unknown>
  }

  it("carries the caller's user id and how their donor role was granted", async () => {
    await seedUser(13, "u13")
    await seedProject("host-m", "Host", 13)
    await seedProject("donor-m", "Donor", 99) // someone else's project...
    await grant("host-m", 13, 500)
    await grant("donor-m", 13, 500) // ...that the caller leads by a direct grant

    const fetchSpy = mockFold({ merged: 1, skipped: [], lane: "fr" })
    const res = await post("host-m", await jwtFor("u13"), { donorProjectId: "donor-m", lane: "fr" })
    expect(res.status).toBe(200)

    expect(foldTokenClaims(fetchSpy)).toMatchObject({
      userId: 13,
      projectId: "host-m",
      role: 500,
      src: "override",
      aud: "sync",
    })
  })

  it("marks a platform operator with no grant on the donor, the fold endpoint's one exemption", async () => {
    // ADMIN_EMAILS is root@example.com in the test env (pg-test-env).
    await seedUser(14, "root")
    await seedProject("host-n", "Host", 99)
    await seedProject("donor-n", "Donor", 99)

    const fetchSpy = mockFold({ merged: 1, skipped: [], lane: "fr" })
    const res = await post("host-n", await jwtFor("root"), { donorProjectId: "donor-n", lane: "fr" })
    expect(res.status).toBe(200)

    expect(foldTokenClaims(fetchSpy)).toMatchObject({ userId: 14, src: "platform" })
  })
})

function readLanes(settings: Record<string, unknown> | undefined): string[] {
  const raw = settings?.targetLanes
  return Array.isArray(raw) ? (raw as string[]) : []
}
