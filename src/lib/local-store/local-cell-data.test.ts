/**
 * Tests for the CellRow + sub-tables → LocalCellData composition. Joins
 * threads + thread_messages, active waivers, and the latest backtranslation
 * into a single read-shape that React consumers can use.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  appendThreadMessage,
  upsertCell,
  upsertThread,
  upsertWaiver,
  upsertBacktranslation,
  type CellRow,
  type ThreadRow,
  type ThreadMessageRow,
  type WaiverRow,
  type BacktranslationRow,
} from "."
import { rowToLocalCellData } from "./local-cell-data"

const NOW = 1_700_000_000_000

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:c1",
    project_id: "p1",
    scope_id: "s1",
    address: "c1",
    ord: 0,
    kind: "verse",
    parent_cell_id: null,
    source_text: "In the beginning",
    source_text_hash: "h",
    source_version_id: "v",
    translation_text: "En el principio",
    tag_dictionary: "{}",
    status: "draft",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 3,
    last_edited_by: "u1",
    last_edited_at: NOW,
    seq: 1,
    created_at: NOW - 1000,
    updated_at: NOW,
    org_id: "org-1",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: JSON.stringify({
      context: "GEN 1:1",
      group: "GEN",
      section: "GEN 1",
      globalReferences: ["GEN 1:2"],
    }),
    label: "GEN 1:1",
    backtranslation_pinned_id: null,
    ...overrides,
  }
}

function makeThread(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: "th-1",
    cell_id: "p1:c1",
    status: "open",
    created_by: "u1",
    created_at: NOW,
    resolved_by: null,
    resolved_at: null,
    seq: 1,
    ...overrides,
  }
}

function makeMessage(overrides: Partial<ThreadMessageRow> = {}): ThreadMessageRow {
  return {
    id: "msg-1",
    thread_id: "th-1",
    author_id: "u1",
    body: "looks good",
    created_at: NOW,
    seq: 1,
    ...overrides,
  }
}

function makeWaiver(overrides: Partial<WaiverRow> = {}): WaiverRow {
  return {
    id: "p1:c1::r1",
    cell_id: "p1:c1",
    cell_version_at: 3,
    text_snapshot: "En el principio",
    rule_id: "r1",
    state: "approved",
    justification: "intentional",
    proposed_by: "u1",
    proposed_at: NOW,
    resolved_by: "u1",
    resolved_at: NOW,
    seq: 1,
    org_id: "org-1",
    ...overrides,
  }
}

function makeBacktranslation(
  overrides: Partial<BacktranslationRow> = {},
): BacktranslationRow {
  return {
    id: "bt:p1:c1@v3",
    cell_id: "p1:c1",
    cell_version_at: 3,
    text_snapshot: "En el principio",
    back_text: "In the beginning",
    generated_by: "ai:claude",
    generated_at: NOW,
    is_user_edited: 0,
    seq: 1,
    ...overrides,
  }
}

describe("rowToLocalCellData", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("populates core fields from the cell row", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    const data = await rowToLocalCellData(store, cell)
    expect(data).toMatchObject({
      id: "p1:c1",
      fileId: "s1",
      original: "In the beginning",
      translated: "En el principio",
      type: "verse",
      status: "draft",
      cellLabel: "GEN 1:1",
      version: 3,
      context: "GEN 1:1",
      group: "GEN",
      section: "GEN 1",
      globalReferences: ["GEN 1:2"],
    })
  })

  test("validationStatus defaults to 'none' until validations migrate (Phase F.8)", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    const data = await rowToLocalCellData(store, cell)
    expect(data.validationStatus).toBe("none")
  })

  test("joins threads with their messages, ordered chronologically", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    await upsertThread(store, makeThread({ id: "th-1" }))
    await appendThreadMessage(store, makeMessage({ id: "m1", body: "first" }))
    await appendThreadMessage(
      store,
      makeMessage({ id: "m2", body: "second", created_at: NOW + 1 }),
    )
    const data = await rowToLocalCellData(store, cell)
    expect(data.threads).toHaveLength(1)
    expect(data.threads[0].messages.map((m) => m.body)).toEqual([
      "first",
      "second",
    ])
  })

  test("includes only active waivers (proposed | approved); skips revoked", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    await upsertWaiver(store, makeWaiver({ id: "w1", state: "approved", rule_id: "r1" }))
    await upsertWaiver(store, makeWaiver({ id: "w2", state: "revoked", rule_id: "r2" }))
    const data = await rowToLocalCellData(store, cell)
    expect(data.waivers.map((w) => w.rule_id)).toEqual(["r1"])
  })

  test("active waivers carry their staleness signal", async () => {
    // Waiver was at v3; cell is now at v5 → stale.
    const cell = makeCell({ version: 5 })
    await upsertCell(store, cell)
    await upsertWaiver(store, makeWaiver({ cell_version_at: 3 }))
    const data = await rowToLocalCellData(store, cell)
    expect(data.waivers[0].is_stale).toBe(true)
    expect(data.waivers[0].cell_version_at).toBe(3)
  })

  test("active waiver at the current version is not stale", async () => {
    const cell = makeCell({ version: 3 })
    await upsertCell(store, cell)
    await upsertWaiver(store, makeWaiver({ cell_version_at: 3 }))
    const data = await rowToLocalCellData(store, cell)
    expect(data.waivers[0].is_stale).toBe(false)
  })

  test("backtranslation attaches the most recent row + flags staleness", async () => {
    const cell = makeCell({ version: 5, translation_text: "New text" })
    await upsertCell(store, cell)
    // Older backtranslation from v3 is stale.
    await upsertBacktranslation(store, makeBacktranslation({ cell_version_at: 3 }))
    const data = await rowToLocalCellData(store, cell)
    expect(data.backtranslation?.back_text).toBe("In the beginning")
    expect(data.backtranslation?.is_stale).toBe(true)
  })

  test("no backtranslation row → backtranslation is null", async () => {
    const cell = makeCell()
    await upsertCell(store, cell)
    const data = await rowToLocalCellData(store, cell)
    expect(data.backtranslation).toBeNull()
  })
})
