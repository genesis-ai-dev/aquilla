// Subscribed termbases after the concepts migration (AQU-1715).
//
// WHY: a project that subscribes to its org's published termbase expects those
// key terms to bind in its own work. Since 2026-09-04 concepts live in the
// `concepts` table, and migrateProjectConcepts deletes the termbase's
// settings.terminology key once it has copied it. Both readers of a subscribed
// termbase parsed only that key, so a migrated termbase gave its subscribers
// nothing: no concepts from the editor's read route, and no term guidance or
// terminology lint in autopilot.
//
// Each test reads the same subscribed termbase through BOTH readers, the
// editor's route (GET /api/v2/projects/:id/termbase/concepts) and autopilot
// (loadProjectContext), and asserts they agree. A term that only one of them
// applies is the drift this fix exists to remove.

import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { loadProjectContext, lintTerminology } from "../lib/contextual/project-context"
// The real producer of a migrated termbase, not a hand-built imitation of it.
import { migrateProjectConcepts } from "../../../sync-worker/src/events/migrate-concepts"

const db = env.AQUILLA_PG

const req = async (method: string, path: string, username: string, body?: Record<string, unknown>) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(await jwtFor(username)),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  )

async function seedSettings(projectId: string, settings: unknown) {
  await db
    .prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    )
    .bind(projectId, JSON.stringify(settings))
    .run()
}

/** One row of the `concepts` projection, written as the term.create
 *  projection writes it (sync-worker/src/events/event-projection.ts). */
async function seedConcept(
  projectId: string,
  row: {
    id: string
    sourceTerm: string
    renderings: { rendering: string; status: string; laneId?: string }[]
    status?: string
    notes?: string
    caseSensitive?: boolean
    match?: unknown
    createdBy?: string
    createdAt?: number
    updatedAt?: number
    deletedAt?: number
  },
) {
  await db
    .prepare(
      `INSERT INTO concepts (concept_id, project_id, source_term, renderings, notes, status,
                             case_sensitive, match_options, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?::text::jsonb, ?, ?, ?, ?::text::jsonb, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      projectId,
      row.sourceTerm,
      JSON.stringify(row.renderings),
      row.notes ?? null,
      row.status ?? "active",
      row.caseSensitive ? 1 : 0,
      row.match === undefined ? null : JSON.stringify(row.match),
      row.createdBy ?? null,
      row.createdAt ?? 1,
      row.updatedAt ?? row.createdAt ?? 1,
      row.deletedAt ?? null,
    )
    .run()
}

// Org 1 owns the published termbase "tb" and its subscriber "consumer".
// anna is an org maintainer, so she can publish, subscribe and read.
async function seedSubscription() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
  await db
    .prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)")
    .run()
  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by) VALUES
        ('tb', 'Termbase', 1, 1), ('tb2', 'Second termbase', 1, 1), ('consumer', 'Consumer', 1, 1)`,
    )
    .run()
  // Autopilot loads no context at all for a project without a settings row.
  await seedSettings("consumer", { sourceLanguage: "English" })
  expect((await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")).status).toBe(200)
  const sub = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
  expect(sub.status).toBe(200)
}

async function readViaRoute(termbaseProjectId = "tb"): Promise<Array<Record<string, unknown>>> {
  const res = await req(
    "GET",
    `/api/v2/projects/${termbaseProjectId}/termbase/concepts?subscriberProjectId=consumer`,
    "anna",
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { concepts: Array<Record<string, unknown>> }).concepts
}

/** The concept ids each reader gives the subscriber, side by side. */
async function idsOnBothPaths(): Promise<{ route: unknown[]; autopilot: string[] }> {
  return {
    route: (await readViaRoute()).map((c) => c.id),
    autopilot: (await loadProjectContext(db, "consumer")).concepts.map((c) => c.id),
  }
}

describe("subscribed termbase concepts (AQU-1715)", () => {
  it("gives a subscriber the active concepts of a migrated termbase, on both paths", async () => {
    await seedSubscription()
    // The termbase as it was stored before 2026-09-04...
    await seedSettings("tb", {
      terminology: [
        {
          id: "grace",
          sourceTerm: "grace",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          renderings: [
            { rendering: "gracia", status: "preferred" },
            { rendering: "suerte", status: "forbidden" },
          ],
        },
        {
          id: "mercy",
          sourceTerm: "mercy",
          status: "draft",
          createdAt: "2026-01-02T00:00:00Z",
          renderings: [{ rendering: "misericordia", status: "preferred" }],
        },
      ],
    })
    // ...then migrated: the concepts land in the table and the key is deleted.
    expect(await migrateProjectConcepts(db, "tb")).toEqual({ migrated: true, count: 2, skipped: 0 })
    const row = await db.prepare("SELECT settings FROM project_settings WHERE project_id = 'tb'").first<{ settings: unknown }>()
    const settings = typeof row?.settings === "string" ? JSON.parse(row.settings) : row?.settings
    expect(settings).not.toHaveProperty("terminology")

    expect(await idsOnBothPaths()).toEqual({ route: ["grace"], autopilot: ["grace"] })
    // What the terms are for: autopilot's lint flags the draft the editor marks.
    const { concepts } = await loadProjectContext(db, "consumer")
    expect(lintTerminology(concepts, "by grace alone", "sólo por suerte").map((h) => h.ruleId)).toEqual([
      "term:grace:approved",
      "term:grace:forbidden:suerte",
    ])
  })

  it("serves each concept as the editor's Concept, with case sensitivity and match options", async () => {
    await seedSubscription()
    await seedConcept("tb", {
      id: "lord",
      sourceTerm: "LORD",
      renderings: [{ rendering: "SEÑOR", status: "preferred" }],
      notes: "Tetragrammaton",
      caseSensitive: true,
      // An unknown key is dropped rather than handed to the matcher.
      match: { forms: ["LORD's"], bogus: 1 },
      createdBy: "anna",
      createdAt: Date.UTC(2026, 8, 10),
      updatedAt: Date.UTC(2026, 8, 11),
    })

    // The editor compiles these with its own concepts. A case-sensitive term
    // read as case-insensitive would flag every "lord" in the project.
    expect(await readViaRoute()).toEqual([
      {
        id: "lord",
        sourceTerm: "LORD",
        renderings: [{ rendering: "SEÑOR", status: "preferred" }],
        status: "active",
        notes: "Tetragrammaton",
        createdBy: "anna",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
        caseSensitive: true,
        match: { forms: ["LORD's"] },
      },
    ])
  })

  it("leaves out draft, deprecated and deleted concepts on both paths", async () => {
    await seedSubscription()
    const renderings = [{ rendering: "x", status: "preferred" }]
    await seedConcept("tb", { id: "live", sourceTerm: "grace", renderings, createdAt: 1 })
    await seedConcept("tb", { id: "draft", sourceTerm: "mercy", renderings, status: "draft", createdAt: 2 })
    await seedConcept("tb", { id: "deprecated", sourceTerm: "law", renderings, status: "deprecated", createdAt: 3 })
    await seedConcept("tb", { id: "deleted", sourceTerm: "faith", renderings, createdAt: 4, deletedAt: 5 })

    expect(await idsOnBothPaths()).toEqual({ route: ["live"], autopilot: ["live"] })
  })

  it("reads the blob only while the termbase has no live rows, as the editor does", async () => {
    await seedSubscription()
    await seedSettings("tb", {
      terminology: [
        { id: "from-blob", sourceTerm: "grace", status: "active", renderings: [{ rendering: "favor", status: "preferred" }] },
      ],
    })
    // A deleted row is not a live row, so it does not stop the fallback.
    await seedConcept("tb", { id: "deleted", sourceTerm: "faith", renderings: [], createdAt: 1, deletedAt: 2 })
    expect(await idsOnBothPaths()).toEqual({ route: ["from-blob"], autopilot: ["from-blob"] })

    // Once the table has a live row, the leftover blob adds nothing.
    await seedConcept("tb", {
      id: "from-table",
      sourceTerm: "grace",
      renderings: [{ rendering: "gracia", status: "preferred" }],
      createdAt: 3,
    })
    expect(await idsOnBothPaths()).toEqual({ route: ["from-table"], autopilot: ["from-table"] })
  })

  it("gives autopilot the termbases in subscription priority order", async () => {
    await seedSubscription()
    expect((await req("POST", "/api/v2/projects/tb2/termbase/publish", "anna")).status).toBe(200)
    const sub = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb2" })
    expect(sub.status).toBe(200)
    // tb was subscribed first, but the maintainer moves tb2 ahead of it.
    const reorder = await req("PATCH", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { order: ["tb2", "tb"] })
    expect(reorder.status).toBe(200)
    await seedConcept("tb", { id: "tb-grace", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] })
    await seedConcept("tb2", { id: "tb2-grace", sourceTerm: "grace", renderings: [{ rendering: "favor", status: "preferred" }] })

    expect((await loadProjectContext(db, "consumer")).concepts.map((c) => c.id)).toEqual(["tb2-grace", "tb-grace"])
  })

  it("drafts without subscribed terms, and says so, when the termbase read fails", async () => {
    await seedSubscription()
    // AQU-1595: the source language is read off the lane row, not the blob.
    await db
      .prepare(
        `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
         VALUES ('consumsrc', 'consumer', 'source', 'English', NULL, 0)`,
      )
      .run()
    await seedConcept("tb", { id: "grace", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] })
    const conceptsDown = {
      prepare: (query: string) => {
        if (query.includes("FROM concepts")) throw new Error("concepts unavailable")
        return db.prepare(query)
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const ctx = await loadProjectContext(conceptsDown, "consumer")
      // The run keeps the rest of its context. It is not failed over the terms.
      expect(ctx.sourceLanguage).toBe("English")
      expect(ctx.concepts).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/subscribed .*consumer/), "concepts unavailable")
    } finally {
      warn.mockRestore()
    }
  })
})

// AQU-1777: a termbase is a project with its own lanes, so its renderings
// carry ITS lane ids (AQU-1508), which never equal the subscriber's. Both
// readers must map them onto the subscriber's lanes by language, or a stamped
// subscribed rendering is absent from every lane of the subscriber.
async function seedLane(
  projectId: string,
  lane: { id: string; legacyTag: string | null; language: string | null; role?: "source" | "target" },
) {
  await db
    .prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
    )
    .bind(lane.id, projectId, lane.role ?? "target", lane.language, lane.legacyTag)
    .run()
}

type ReadRendering = { rendering: string; laneId?: string }
/** `[rendering, laneId]` pairs of one concept as route #8 returned it. */
const renderingsOf = (concepts: Array<Record<string, unknown>>, id: string) =>
  (concepts.find((c) => c.id === id)?.renderings as ReadRendering[] | undefined)?.map((r) => [
    r.rendering,
    r.laneId ?? null,
  ]) ?? null

const autopilotRenderings = async (lane: { laneId?: string; targetLang?: string }, id = "grace") =>
  (await loadProjectContext(db, "consumer", lane)).concepts.find((c) => c.id === id)?.renderings.map((r) => r.rendering) ?? null

describe("subscribed renderings follow the subscriber's lanes (AQU-1777)", () => {
  it("stamps each rendering with the subscriber lane of the same language, on both paths", async () => {
    await seedSubscription()
    // The termbase: a Spanish `''` lane and a French lane.
    await seedLane("tb", { id: "tb00055c", legacyTag: null, language: "English", role: "source" })
    await seedLane("tb", { id: "tb000e5a", legacyTag: "", language: "Spanish" })
    await seedLane("tb", { id: "tb000f7a", legacyTag: "fr", language: "French" })
    // The subscriber: a Spanish `''` lane (lower-case) and a Canadian-French
    // lane tagged with its own id, as planNewTargetLane tags a second lane.
    await seedLane("consumer", { id: "c000055c", legacyTag: null, language: "English", role: "source" })
    await seedLane("consumer", { id: "c0000e5a", legacyTag: "", language: "spanish" })
    await seedLane("consumer", { id: "c0ffee01", legacyTag: "c0ffee01", language: "fr-CA" })
    await seedConcept("tb", {
      id: "grace",
      sourceTerm: "grace",
      renderings: [
        { rendering: "gracia", status: "preferred", laneId: "tb000e5a" },
        { rendering: "grâce", status: "preferred", laneId: "tb000f7a" },
        // Unstamped: the termbase's `''` lane, so Spanish.
        { rendering: "favor", status: "admitted" },
        // Stamped with a lane the termbase no longer has: applies nowhere.
        { rendering: "grazia", status: "admitted", laneId: "tb000111" },
      ],
    })

    expect(renderingsOf(await readViaRoute(), "grace")).toEqual([
      ["gracia", "c0000e5a"],
      ["grâce", "c0ffee01"],
      ["favor", "c0000e5a"],
    ])
    expect(await autopilotRenderings({ targetLang: "" })).toEqual(["gracia", "favor"])
    expect(await autopilotRenderings({ laneId: "c0ffee01" })).toEqual(["grâce"])
    // What the mapping is for: the French lane's run is held to the French rendering.
    const french = await loadProjectContext(db, "consumer", { laneId: "c0ffee01" })
    expect(lintTerminology(french.concepts, "by grace alone", "par la faveur").map((h) => h.ruleId)).toEqual([
      "term:grace:approved",
    ])
    expect(lintTerminology(french.concepts, "by grace alone", "par la grâce")).toEqual([])
  })

  it("reads an unstamped rendering as the termbase's '' lane, never the subscriber's", async () => {
    await seedSubscription()
    await seedLane("tb", { id: "tb000e5a", legacyTag: "", language: "Spanish" })
    // The subscriber's `''` lane is English; its Spanish lane is tagged "es".
    await seedLane("consumer", { id: "c0000e00", legacyTag: "", language: "English" })
    await seedLane("consumer", { id: "c0000e5a", legacyTag: "es", language: "Spanish" })
    await seedConcept("tb", { id: "grace", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] })

    expect(renderingsOf(await readViaRoute(), "grace")).toEqual([["gracia", "c0000e5a"]])
    expect(await autopilotRenderings({ targetLang: "" })).toEqual([])
    expect(await autopilotRenderings({ targetLang: "es" })).toEqual(["gracia"])
  })

  it("leaves out a rendering whose termbase lane no subscriber lane matches", async () => {
    await seedSubscription()
    await seedLane("tb", { id: "tb000f7a", legacyTag: "", language: "French" })
    await seedLane("consumer", { id: "c0000e5a", legacyTag: "", language: "Spanish" })
    await seedConcept("tb", { id: "grace", sourceTerm: "grace", renderings: [{ rendering: "grâce", status: "preferred" }] })

    expect(renderingsOf(await readViaRoute(), "grace")).toEqual([])
    const ctx = await loadProjectContext(db, "consumer", { targetLang: "" })
    expect(ctx.concepts.find((c) => c.id === "grace")?.renderings).toEqual([])
    expect(lintTerminology(ctx.concepts, "by grace alone", "sólo por favor")).toEqual([])
  })

  it("matches by legacy_tag when a lane has no language yet", async () => {
    await seedSubscription()
    // An un-backfilled termbase `''` lane records no language.
    await seedLane("tb", { id: "tb000e5a", legacyTag: "", language: null })
    await seedLane("consumer", { id: "c0000e5a", legacyTag: "", language: "Spanish" })
    await seedLane("consumer", { id: "c0000f7a", legacyTag: "fr", language: "French" })
    await seedConcept("tb", { id: "grace", sourceTerm: "grace", renderings: [{ rendering: "gracia", status: "preferred" }] })

    expect(renderingsOf(await readViaRoute(), "grace")).toEqual([["gracia", "c0000e5a"]])
    expect(await autopilotRenderings({ targetLang: "" })).toEqual(["gracia"])
    expect(await autopilotRenderings({ targetLang: "fr" })).toEqual([])
  })
})
