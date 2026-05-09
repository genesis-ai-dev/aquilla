/**
 * Repository tests for the edit-keyed `waivers` table.
 * See DATA_PERSISTENCE_PLAN.md §4.10 (cell-keyed vs edit-keyed) and §4.11.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  getActiveWaiversForCell,
  getWaiver,
  upsertWaiver,
  type WaiverRow,
} from "./waivers"

const NOW = 1_700_000_000_000

function makeWaiver(overrides: Partial<WaiverRow> = {}): WaiverRow {
  return {
    id: "w-1",
    cell_id: "p1:c1",
    cell_version_at: 3,
    text_snapshot: "Lo siento, hermano",
    rule_id: "no-spanish-honorifics",
    state: "approved",
    justification: "intentional regional flavor",
    proposed_by: "u1",
    proposed_at: NOW,
    resolved_by: "u1",
    resolved_at: NOW,
    seq: 1,
    org_id: "org-1",
    ...overrides,
  }
}

describe("waivers repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("upsertWaiver + getWaiver round-trip", async () => {
    const w = makeWaiver()
    await upsertWaiver(store, w)
    expect(await getWaiver(store, w.id)).toEqual(w)
  })

  test("getActiveWaiversForCell returns proposed + approved, not revoked", async () => {
    await upsertWaiver(
      store,
      makeWaiver({ id: "w-prop", state: "proposed", rule_id: "r1" }),
    )
    await upsertWaiver(
      store,
      makeWaiver({ id: "w-appr", state: "approved", rule_id: "r2" }),
    )
    await upsertWaiver(
      store,
      makeWaiver({ id: "w-revk", state: "revoked", rule_id: "r3" }),
    )
    const rows = await getActiveWaiversForCell(store, "p1:c1")
    expect(rows.map((r) => r.id).sort()).toEqual(["w-appr", "w-prop"])
  })

  test("getActiveWaiversForCell scopes by cell", async () => {
    await upsertWaiver(store, makeWaiver({ id: "a", cell_id: "p1:c1" }))
    await upsertWaiver(store, makeWaiver({ id: "b", cell_id: "p1:c2" }))
    expect(
      (await getActiveWaiversForCell(store, "p1:c1")).map((r) => r.id),
    ).toEqual(["a"])
  })

  test("waiver carries text_snapshot — edit-keyed contract", async () => {
    const w = makeWaiver({ text_snapshot: "version-3 text" })
    await upsertWaiver(store, w)
    const got = await getWaiver(store, w.id)
    expect(got?.text_snapshot).toBe("version-3 text")
    expect(got?.cell_version_at).toBe(3)
  })

  test("two waivers can coexist for the same (cell, rule) at different cell_version_at", async () => {
    // The version moved from 3 to 4; the v3 waiver stays as historical.
    await upsertWaiver(
      store,
      makeWaiver({ id: "v3", cell_version_at: 3 }),
    )
    await upsertWaiver(
      store,
      makeWaiver({ id: "v4", cell_version_at: 4 }),
    )
    const all = await getActiveWaiversForCell(store, "p1:c1")
    expect(all.map((r) => r.cell_version_at).sort()).toEqual([3, 4])
  })
})
