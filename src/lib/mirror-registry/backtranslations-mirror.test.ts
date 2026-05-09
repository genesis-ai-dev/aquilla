/**
 * backtranslations-mirror: Y.Doc cell.backtranslation/backtranslationForText/
 * backtranslationUpdatedAt → local-store `backtranslations` rows. Edit-keyed
 * — each row carries text_snapshot from when the back-translation was
 * generated.
 */

import { beforeEach, describe, expect, test } from "vitest"
import * as Y from "yjs"
import { LocalStore } from "@/lib/local-store/db"
import { MIGRATIONS } from "@/lib/local-store/migrations"
import { listPending } from "@/lib/local-store/outbox"
import { upsertCell } from "@/lib/local-store/cells"
import { getActiveBacktranslation } from "@/lib/local-store/backtranslations"
import type { CellRow } from "@/lib/local-store/cells"
import type { MirrorContext } from "./registry"
import { createBacktranslationsMirror } from "./backtranslations-mirror"

const NOW = 1_700_000_000_000

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:c1",
    project_id: "p1",
    scope_id: "s",
    address: "c1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "src",
    source_text_hash: "h",
    source_version_id: "v",
    translation_text: "El gato es negro",
    tag_dictionary: "{}",
    status: "draft",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 3,
    last_edited_by: null,
    last_edited_at: null,
    seq: 1,
    created_at: 0,
    updated_at: 0,
    org_id: "org-1",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: "{}",
    label: null,
    backtranslation_pinned_id: null,
    ...overrides,
  }
}

function ensureCell(yDoc: Y.Doc, cellId: string): Y.Map<unknown> {
  const cellsMap = yDoc.getMap("cells")
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map()
    cellsMap.set(cellId, cell)
  }
  return cell
}

function setBacktranslation(
  yDoc: Y.Doc,
  cellId: string,
  fields: { back: string; forText: string; updatedAt: string },
): void {
  yDoc.transact(() => {
    const cell = ensureCell(yDoc, cellId)
    cell.set("backtranslation", fields.back)
    cell.set("backtranslationForText", fields.forText)
    cell.set("backtranslationUpdatedAt", fields.updatedAt)
  })
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}

async function setup(): Promise<{
  yDoc: Y.Doc
  store: LocalStore
  ctx: MirrorContext
  cleanup: () => Promise<void>
}> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  const yDoc = new Y.Doc()
  const ctx: MirrorContext = {
    store,
    actorId: "u1",
    now: () => NOW,
  }
  return {
    yDoc,
    store,
    ctx,
    cleanup: async () => {
      yDoc.destroy()
      await store.close()
    },
  }
}

describe("backtranslations mirror", () => {
  let yDoc: Y.Doc
  let store: LocalStore
  let ctx: MirrorContext
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ yDoc, store, ctx, cleanup } = await setup())
  })

  test("bootstrap captures current backtranslation as the v3 row", async () => {
    await upsertCell(store, makeCell({ version: 3, translation_text: "El gato es negro" }))
    setBacktranslation(yDoc, "p1:c1", {
      back: "The cat is black",
      forText: "El gato es negro",
      updatedAt: new Date(NOW).toISOString(),
    })

    const mirror = createBacktranslationsMirror({ yDoc })
    await mirror.bootstrap(ctx)

    const got = await getActiveBacktranslation(store, "p1:c1")
    expect(got).toMatchObject({
      cell_id: "p1:c1",
      cell_version_at: 3,
      text_snapshot: "El gato es negro",
      back_text: "The cat is black",
      is_user_edited: 0,
    })

    await cleanup()
  })

  test("bootstrap is idempotent — rerunning replaces in-place at same version", async () => {
    await upsertCell(store, makeCell({ version: 3 }))
    setBacktranslation(yDoc, "p1:c1", {
      back: "first",
      forText: "El gato es negro",
      updatedAt: new Date(NOW).toISOString(),
    })
    const mirror = createBacktranslationsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    await mirror.bootstrap(ctx)
    const all = await store.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM backtranslations WHERE cell_id = ?",
      ["p1:c1"],
    )
    expect(all[0].count).toBe(1)
    await cleanup()
  })

  test("attach: a newly generated backtranslation emits backtranslation.set outbox", async () => {
    await upsertCell(store, makeCell({ version: 5, translation_text: "Nuevo" }))
    const mirror = createBacktranslationsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    setBacktranslation(yDoc, "p1:c1", {
      back: "New",
      forText: "Nuevo",
      updatedAt: new Date(NOW + 1000).toISOString(),
    })
    await flush()

    const got = await getActiveBacktranslation(store, "p1:c1")
    expect(got?.back_text).toBe("New")
    expect(got?.cell_version_at).toBe(5)

    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    expect(kinds).toContain("backtranslation.set")

    dispose()
    await cleanup()
  })

  test("a regenerated backtranslation at a new version creates a second historical row", async () => {
    // First: cell at v3 with backtranslation
    await upsertCell(store, makeCell({ version: 3, translation_text: "v3 text" }))
    setBacktranslation(yDoc, "p1:c1", {
      back: "v3 back",
      forText: "v3 text",
      updatedAt: new Date(NOW).toISOString(),
    })
    const mirror = createBacktranslationsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    // Cell version moves to 5; new backtranslation generated.
    await upsertCell(store, makeCell({ version: 5, translation_text: "v5 text" }))
    setBacktranslation(yDoc, "p1:c1", {
      back: "v5 back",
      forText: "v5 text",
      updatedAt: new Date(NOW + 5).toISOString(),
    })
    await flush()

    // Both rows present.
    const all = await store.query<{ id: string; cell_version_at: number }>(
      "SELECT id, cell_version_at FROM backtranslations WHERE cell_id = ? ORDER BY cell_version_at",
      ["p1:c1"],
    )
    expect(all.map((r) => r.cell_version_at)).toEqual([3, 5])

    // Active = latest.
    const active = await getActiveBacktranslation(store, "p1:c1")
    expect(active?.cell_version_at).toBe(5)
    expect(active?.back_text).toBe("v5 back")

    dispose()
    await cleanup()
  })

  test("dispose stops observation", async () => {
    await upsertCell(store, makeCell({ version: 1 }))
    const mirror = createBacktranslationsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)
    dispose()

    setBacktranslation(yDoc, "p1:c1", {
      back: "should not propagate",
      forText: "x",
      updatedAt: new Date(NOW).toISOString(),
    })
    await flush()
    expect(await getActiveBacktranslation(store, "p1:c1")).toBeNull()
    await cleanup()
  })
})
