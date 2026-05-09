import { beforeEach, describe, expect, test } from "vitest"
import * as Y from "yjs"
import {
  getCell,
  listPending,
  LocalStore,
  MIGRATIONS,
  upsertCell,
  type CellRow,
} from "@/lib/local-store"
import { createTranslationTextMirror } from "./translation-text-mirror"
import type { MirrorContext } from "./registry"

const NOW = 1_700_000_000_000

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:c1",
    project_id: "p1",
    scope_id: "s1",
    address: "c1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "In the beginning",
    source_text_hash: "h",
    source_version_id: "v",
    translation_text: "",
    tag_dictionary: "{}",
    status: "empty",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 0,
    last_edited_by: null,
    last_edited_at: null,
    seq: 1,
    created_at: 0,
    updated_at: 0,
    org_id: "o",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: "{}",
    label: null,
    backtranslation_pinned_id: null,
    ...overrides,
  }
}

function seedYDoc(yDoc: Y.Doc, cellId: string): Y.XmlFragment {
  const cellsMap = yDoc.getMap("cells")
  const yCell = new Y.Map()
  const fragment = new Y.XmlFragment()
  yCell.set("translatedXml", fragment)
  cellsMap.set(cellId, yCell)
  return fragment
}

function appendText(yDoc: Y.Doc, fragment: Y.XmlFragment, text: string): void {
  yDoc.transact(() => {
    const para = new Y.XmlElement("p")
    para.insert(0, [new Y.XmlText(text)])
    fragment.insert(fragment.length, [para])
  })
}

async function flushObservers(): Promise<void> {
  // Mirror observers schedule async writes; give them a tick to drain.
  await new Promise((r) => setTimeout(r, 20))
}

async function setup(): Promise<{
  store: LocalStore
  yDoc: Y.Doc
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
    store,
    yDoc,
    ctx,
    cleanup: async () => {
      yDoc.destroy()
      await store.close()
    },
  }
}

describe("translation-text mirror", () => {
  let store: LocalStore
  let yDoc: Y.Doc
  let ctx: MirrorContext
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ store, yDoc, ctx, cleanup } = await setup())
  })

  test("Y.Doc edit propagates to cells.translation_text and bumps version", async () => {
    await upsertCell(store, makeCell())
    const fragment = seedYDoc(yDoc, "p1:c1")

    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)

    appendText(yDoc, fragment, "Hola")
    await flushObservers()

    const updated = await getCell(store, "p1:c1")
    expect(updated?.translation_text).toBe("Hola")
    expect(updated?.version).toBe(1)
    expect(updated?.last_edited_by).toBe("u1")
    expect(updated?.last_edited_at).toBe(NOW)

    dispose()
    await cleanup()
  })

  test("each propagated edit enqueues a cell.set_translation outbox record", async () => {
    await upsertCell(store, makeCell())
    const fragment = seedYDoc(yDoc, "p1:c1")
    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)

    appendText(yDoc, fragment, "Hola")
    await flushObservers()

    const pending = await listPending(store)
    expect(pending).toHaveLength(1)
    const payload = JSON.parse(pending[0].payload) as {
      kind: string
      translation_text: string
      expected_version: number
    }
    expect(payload.kind).toBe("cell.set_translation")
    expect(payload.translation_text).toBe("Hola")
    expect(payload.expected_version).toBe(0)
    expect(pending[0].endpoint).toBe(
      "/projects/p1/cells/p1:c1",
    )

    dispose()
    await cleanup()
  })

  test("dispose unobserves; later edits do not propagate", async () => {
    await upsertCell(store, makeCell())
    const fragment = seedYDoc(yDoc, "p1:c1")
    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)
    dispose()

    appendText(yDoc, fragment, "Should be ignored")
    await flushObservers()

    const cell = await getCell(store, "p1:c1")
    expect(cell?.translation_text).toBe("")
    expect(cell?.version).toBe(0)

    await cleanup()
  })

  test("ignores Y.Doc cells that have no row in local store", async () => {
    const fragment = seedYDoc(yDoc, "p1:absent")
    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)

    appendText(yDoc, fragment, "Stranded")
    await flushObservers()

    const cell = await getCell(store, "p1:absent")
    expect(cell).toBeNull()
    const pending = await listPending(store)
    expect(pending).toEqual([])

    dispose()
    await cleanup()
  })

  test("no-op when the derived plain text matches the existing row", async () => {
    await upsertCell(store, makeCell({ translation_text: "Hola" }))
    const fragment = seedYDoc(yDoc, "p1:c1")
    appendText(yDoc, fragment, "Hola")
    // Now attach: mirror should not bump version because the text matches.
    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)

    appendText(yDoc, fragment, "")
    await flushObservers()

    const cell = await getCell(store, "p1:c1")
    expect(cell?.version).toBe(0)
    const pending = await listPending(store)
    expect(pending).toEqual([])

    dispose()
    await cleanup()
  })

  test("multiple cells in one Y.Doc transaction each get their own outbox record", async () => {
    await upsertCell(store, makeCell({ id: "p1:c1", address: "c1" }))
    await upsertCell(
      store,
      makeCell({ id: "p1:c2", address: "c2", ord: 1 }),
    )
    const fragment1 = seedYDoc(yDoc, "p1:c1")
    const fragment2 = seedYDoc(yDoc, "p1:c2")
    const mirror = createTranslationTextMirror({ yDoc })
    const dispose = mirror.attach(ctx)

    yDoc.transact(() => {
      const p1 = new Y.XmlElement("p")
      p1.insert(0, [new Y.XmlText("uno")])
      fragment1.insert(0, [p1])
      const p2 = new Y.XmlElement("p")
      p2.insert(0, [new Y.XmlText("dos")])
      fragment2.insert(0, [p2])
    })
    await flushObservers()

    const c1 = await getCell(store, "p1:c1")
    const c2 = await getCell(store, "p1:c2")
    expect(c1?.translation_text).toBe("uno")
    expect(c2?.translation_text).toBe("dos")
    const pending = await listPending(store)
    expect(pending).toHaveLength(2)

    dispose()
    await cleanup()
  })

  test("bootstrap is a no-op (cells exist via snapshot ingest, not from Y.Doc)", async () => {
    await upsertCell(store, makeCell())
    seedYDoc(yDoc, "p1:c1")
    const mirror = createTranslationTextMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const pending = await listPending(store)
    expect(pending).toEqual([])
    await cleanup()
  })
})
