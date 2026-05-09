/**
 * Repository tests for the edit-keyed `backtranslations` table.
 * See DATA_PERSISTENCE_PLAN.md §4.11.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  getActiveBacktranslation,
  getBacktranslation,
  upsertBacktranslation,
  type BacktranslationRow,
} from "./backtranslations"

const NOW = 1_700_000_000_000

function make(overrides: Partial<BacktranslationRow> = {}): BacktranslationRow {
  return {
    id: "bt-1",
    cell_id: "p1:c1",
    cell_version_at: 3,
    text_snapshot: "El gato es negro",
    back_text: "The cat is black",
    generated_by: "ai:claude-opus-4-7",
    generated_at: NOW,
    is_user_edited: 0,
    seq: 1,
    ...overrides,
  }
}

describe("backtranslations repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("upsertBacktranslation + getBacktranslation round-trip", async () => {
    const b = make()
    await upsertBacktranslation(store, b)
    expect(await getBacktranslation(store, b.id)).toEqual(b)
  })

  test("UNIQUE(cell_id, cell_version_at) — re-upsert at same version replaces", async () => {
    await upsertBacktranslation(store, make({ id: "bt-old", back_text: "old" }))
    await upsertBacktranslation(
      store,
      make({ id: "bt-new", back_text: "new" }),
    )
    // Both rows survive when ids differ; the "new" one wins on cell+version
    // but we don't enforce that — the caller picks the latest.
    const all = await store.query<BacktranslationRow>(
      "SELECT * FROM backtranslations WHERE cell_id = ? ORDER BY id",
      ["p1:c1"],
    )
    // The UNIQUE constraint is on (cell_id, cell_version_at), and INSERT OR
    // REPLACE on the unique index throws — only one should remain.
    expect(all).toHaveLength(1)
  })

  test("getActiveBacktranslation returns the latest by cell_version_at", async () => {
    await upsertBacktranslation(
      store,
      make({ id: "v3", cell_version_at: 3, back_text: "v3 back" }),
    )
    await upsertBacktranslation(
      store,
      make({ id: "v5", cell_version_at: 5, back_text: "v5 back" }),
    )
    await upsertBacktranslation(
      store,
      make({ id: "v4", cell_version_at: 4, back_text: "v4 back" }),
    )
    const got = await getActiveBacktranslation(store, "p1:c1")
    expect(got?.id).toBe("v5")
    expect(got?.back_text).toBe("v5 back")
  })

  test("getActiveBacktranslation returns null when none exist", async () => {
    expect(await getActiveBacktranslation(store, "p1:c1")).toBeNull()
  })

  test("is_user_edited flag distinguishes AI from user-edited backtranslations", async () => {
    await upsertBacktranslation(store, make({ is_user_edited: 1 }))
    const got = await getBacktranslation(store, "bt-1")
    expect(got?.is_user_edited).toBe(1)
  })
})
