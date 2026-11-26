// AQU-2719 step 1 — `livingMemoryEntries` is stored as ROWS, and a client
// cannot tell.
//
// The settings blob is one multi-MB JSON text column, so every unrelated read
// parses the authored living-memory entries and every save re-serializes them.
// They now live in `project_living_memory_entries`. The whole safety case for
// that move is "the key never leaves the API surface", and a client's
// read-modify-write save still carries it — so the thing worth pinning is the
// BEFORE/AFTER comparison of what a client reads, not the row shape.
//
// Pinned here, against real Postgres through the real route:
//   1. What a client reads is byte-identical across the move, for a blob that
//      carries a large collection AND a malformed entry.
//   2. The move empties the key out of the blob, which is the point.
//   3. An entry the move cannot carry stays in the blob and keeps being read
//      from there — a reader never assumes the rows are the whole truth.
//   4. A save by a client that echoes the key lands in the rows, and the
//      blob it stores no longer carries them.
//   5. Deleting the last entry leaves the key present and empty, never
//      absent: `project-settings-overlay.ts::assign` ignores an absent value
//      and would keep showing a deleted list.
//   6. The move is idempotent and safe to re-run.
//   7. An unrelated settings save does not disturb the entries.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  migrateProjectLivingMemory,
  type LivingMemoryEntryRecord,
} from "../../../db/shared/living-memory-entries"
import { loadProjectSettings } from "../../../db/shared/projects"
import { loadTranslationInstructions } from "../../../db/shared/load-translation-instructions"

function entry(i: number): LivingMemoryEntryRecord {
  return {
    id: `e${i}`,
    kind: i % 3 === 0 ? "instruction" : "standard",
    text: `Entry ${i}: keep the register formal.`,
    createdAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    author: i % 2 === 0 ? "alice" : "bob",
  }
}

/** A large collection, as the ticket requires the test to carry. */
const MANY = Array.from({ length: 250 }, (_, i) => entry(i))

const OTHER_SETTINGS = {
  systemPrompt: "Keep the register formal.",
  validationCount: 2,
  translationBrief: { audience: "village readers" },
}

async function seed(stored: Record<string, unknown>): Promise<void> {
  await seedUser(1, "alice")
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
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Blob', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(stored))
    .run()
}

/** What a client reads: the settings GET, as the SPA calls it. */
async function clientRead(): Promise<Record<string, unknown>> {
  const res = await app.request(
    "/api/v2/projects/p1/settings",
    { headers: authHeader(await jwtFor("alice")) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { settings: Record<string, unknown> }
  return body.settings
}

async function save(
  settings: Record<string, unknown>,
  ifMatchVersion: number,
): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

/** The raw stored blob — what every unrelated read has to parse. */
async function storedBlob(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

async function rowCount(): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*)::int AS n FROM project_living_memory_entries WHERE project_id = 'p1'",
  ).first<{ n: number }>()
  return row?.n ?? 0
}

describe("AQU-2719: living-memory entries move to rows", () => {
  it("a client reads the same settings before and after the move", async () => {
    // A malformed entry (no id) rides along with the large collection, as the
    // ticket requires: the move must not change what a client sees of it.
    const malformed = { kind: "standard", text: "no id, so it cannot be a row" }
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [...MANY, malformed] })

    const before = await clientRead()
    expect(before.livingMemoryEntries).toHaveLength(251)

    const result = await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")
    expect(result).toEqual({ migrated: true, count: 250, skipped: 1 })

    const after = await clientRead()
    // The whole safety case, in one assertion.
    expect(after).toEqual(before)

    // …and the point of the exercise: the blob no longer carries the 250.
    const blob = await storedBlob()
    expect(blob.livingMemoryEntries).toEqual([malformed])
    expect(blob.systemPrompt).toBe(OTHER_SETTINGS.systemPrompt)
    expect(await rowCount()).toBe(250)

    // A storage move is not a user edit: the version must not move, or every
    // in-flight save would 409 for no reason.
    const stored = await loadProjectSettings(env.AQUILLA_PG, "p1")
    expect(stored.version).toBe(1)
  })

  it("clears the key entirely when every entry was carried", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1), entry(2)] })
    const before = await clientRead()

    expect(await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")).toEqual({
      migrated: true,
      count: 2,
      skipped: 0,
    })

    expect(await clientRead()).toEqual(before)
    expect(Object.prototype.hasOwnProperty.call(await storedBlob(), "livingMemoryEntries")).toBe(false)
  })

  it("is idempotent: a second run writes nothing and changes nothing", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1), entry(2), entry(3)] })
    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")
    const afterFirst = await clientRead()

    expect(await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")).toEqual({
      migrated: false,
      count: 0,
      skipped: 0,
    })
    expect(await clientRead()).toEqual(afterFirst)
    expect(await rowCount()).toBe(3)
  })

  it("leaves a value that is not an array exactly where it is", async () => {
    // Not this module's to interpret, so it must not be rewritten or dropped.
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: { broken: true } })
    const before = await clientRead()

    expect(await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")).toEqual({
      migrated: false,
      count: 0,
      skipped: 0,
    })

    expect(await clientRead()).toEqual(before)
    expect((await storedBlob()).livingMemoryEntries).toEqual({ broken: true })
    expect(await rowCount()).toBe(0)
  })

  it("a client save lands in the rows, not in the blob", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1)] })
    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")

    // The SPA echoes the whole blob it last read, with the key edited.
    const echoed = await clientRead()
    const added = [...(echoed.livingMemoryEntries as LivingMemoryEntryRecord[]), entry(2)]
    const res = await save({ ...echoed, livingMemoryEntries: added }, 1)
    expect(res.status).toBe(200)

    expect((await clientRead()).livingMemoryEntries).toEqual(added)
    expect(Object.prototype.hasOwnProperty.call(await storedBlob(), "livingMemoryEntries")).toBe(false)
    expect(await rowCount()).toBe(2)
  })

  it("a save on an un-migrated project is itself the move", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1), entry(2)] })
    const echoed = await clientRead()

    // Nothing about living memory changed — an ordinary settings edit.
    const res = await save({ ...echoed, systemPrompt: "Be terse." }, 1)
    expect(res.status).toBe(200)

    const after = await clientRead()
    expect(after.livingMemoryEntries).toEqual(echoed.livingMemoryEntries)
    expect(after.systemPrompt).toBe("Be terse.")
    expect(Object.prototype.hasOwnProperty.call(await storedBlob(), "livingMemoryEntries")).toBe(false)
    expect(await rowCount()).toBe(2)
  })

  it("deleting the last entry leaves the key present and empty, never absent", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1), entry(2)] })
    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")

    const echoed = await clientRead()
    expect(await (await save({ ...echoed, livingMemoryEntries: [] }, 1)).status).toBe(200)

    const after = await clientRead()
    // An absent key would be ignored by the client overlay, which would go on
    // showing the entries the user just deleted.
    expect(after.livingMemoryEntries).toEqual([])
    expect(await rowCount()).toBe(0)
  })

  it("an unrelated save does not disturb the entries — and does not rewrite them", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: MANY })
    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")
    const echoed = await clientRead()

    // A rewrite reassigns every row's sort_index from the array position, so
    // spreading the stored positions out is the cheapest way to SEE whether
    // the save touched the rows: the ORDER is unchanged (so the save still
    // reads an unchanged collection, which is the case under test) but the
    // values are distinguishable from the array indexes a rewrite would
    // write. It matters: the SPA echoes every key it did not touch, and
    // `batch()` runs sequentially, so rewriting on an unrelated save would
    // cost one round-trip per entry for no change.
    await env.AQUILLA_PG.prepare(
      "UPDATE project_living_memory_entries SET sort_index = sort_index * 10 WHERE project_id = 'p1'",
    ).run()

    expect(await (await save({ ...echoed, validationCount: 3 }, 1)).status).toBe(200)

    const sentinel = await env.AQUILLA_PG.prepare(
      "SELECT sort_index FROM project_living_memory_entries WHERE entry_id = 'e5'",
    ).first<{ sort_index: number }>()
    expect(sentinel?.sort_index).toBe(50)

    const after = await clientRead()
    expect(after.validationCount).toBe(3)
    expect(await rowCount()).toBe(250)
    expect(after.livingMemoryEntries).toEqual(echoed.livingMemoryEntries)
  })

  it("a save that changes the entries does rewrite them", async () => {
    await seed({ ...OTHER_SETTINGS, livingMemoryEntries: [entry(1), entry(2)] })
    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")
    await env.AQUILLA_PG.prepare(
      "UPDATE project_living_memory_entries SET sort_index = 9999 WHERE entry_id = 'e1'",
    ).run()

    const echoed = await clientRead()
    const edited = [{ ...entry(1), text: "edited" }, entry(2)]
    expect(await (await save({ ...echoed, livingMemoryEntries: edited }, 1)).status).toBe(200)

    // The position is reassigned from the array, so the sentinel is gone.
    const sentinel = await env.AQUILLA_PG.prepare(
      "SELECT sort_index, text FROM project_living_memory_entries WHERE entry_id = 'e1'",
    ).first<{ sort_index: number; text: string }>()
    expect(sentinel).toEqual({ sort_index: 0, text: "edited" })
    expect((await clientRead()).livingMemoryEntries).toEqual(edited)
  })

  // The silent-failure case this change had to close. A project with no
  // `translationInstructions` key composes its instructions on read, and a
  // legacy Living Memory "instruction" entry is one of the sources — read by
  // `loadTranslationInstructions`, which has its OWN `SELECT settings` and so
  // never sees the key put back by `loadProjectSettings`. If that path is not
  // merged, moving a project silently drops the instruction from every
  // drafting prompt and nothing says so.
  it("a legacy instruction entry still reaches the composed instructions after the move", async () => {
    const instruction = {
      id: "e-instr",
      kind: "instruction" as const,
      text: "Always render YHWH as the LORD.",
      createdAt: "2026-03-04T00:00:00.000Z",
      author: "alice",
    }
    // No translationInstructions key: this is the compose-on-read path.
    await seed({ systemPrompt: "", livingMemoryEntries: [instruction] })

    const before = await loadTranslationInstructions(env.AQUILLA_PG, "p1")
    expect(before.stored).toBe(false)
    expect(before.text).toContain("Always render YHWH as the LORD.")

    await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")

    const after = await loadTranslationInstructions(env.AQUILLA_PG, "p1")
    expect(after).toEqual(before)
  })

  it("a project with no entries is untouched, and still reads with no key", async () => {
    await seed(OTHER_SETTINGS)
    expect(await migrateProjectLivingMemory(env.AQUILLA_PG, "p1")).toEqual({
      migrated: false,
      count: 0,
      skipped: 0,
    })
    const after = await clientRead()
    expect(Object.prototype.hasOwnProperty.call(after, "livingMemoryEntries")).toBe(false)
  })
})
