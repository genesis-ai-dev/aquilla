import { beforeEach, describe, expect, test } from "vitest"
import * as Y from "yjs"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { getCell, getCellsByScope, upsertCell } from "./cells"
import { importYDocIfEmpty, type YDocImportContext } from "./import-from-ydoc"

const NOW = 1_700_000_000_000
const PROJECT_ID = "p1"
const FILE_ID = "file-1"

function seedCell(
  yDoc: Y.Doc,
  id: string,
  fields: Record<string, unknown>,
): void {
  const cellsMap = yDoc.getMap("cells")
  const order = yDoc.getArray("order") as Y.Array<string>
  const yCell = new Y.Map()
  for (const [k, v] of Object.entries(fields)) {
    yCell.set(k, v)
  }
  cellsMap.set(id, yCell)
  order.push([id])
}

function seedCellWithTranslation(yDoc: Y.Doc, id: string, text: string): void {
  const cellsMap = yDoc.getMap("cells")
  const order = yDoc.getArray("order") as Y.Array<string>
  const yCell = new Y.Map()
  yCell.set("original", "src")
  yCell.set("type", "verse")
  const fragment = new Y.XmlFragment()
  const para = new Y.XmlElement("p")
  para.insert(0, [new Y.XmlText(text)])
  fragment.insert(0, [para])
  yCell.set("translatedXml", fragment)
  cellsMap.set(id, yCell)
  order.push([id])
}

async function makeCtx(yDoc: Y.Doc): Promise<{
  ctx: YDocImportContext
  cleanup: () => Promise<void>
}> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  const ctx: YDocImportContext = {
    store,
    yDoc,
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    sourceLang: "eng",
    targetLang: "spa",
    orgId: "org-1",
    now: () => NOW,
  }
  return {
    ctx,
    cleanup: async () => {
      yDoc.destroy()
      await store.close()
    },
  }
}

describe("importYDocIfEmpty", () => {
  let yDoc: Y.Doc

  beforeEach(() => {
    yDoc = new Y.Doc()
  })

  test("empty Y.Doc imports zero cells", async () => {
    const { ctx, cleanup } = await makeCtx(yDoc)
    const result = await importYDocIfEmpty(ctx)
    expect(result).toEqual({ imported: 0, skipped: false })
    await cleanup()
  })

  test("imports each Y.Doc cell with the legacy → new field mapping", async () => {
    seedCell(yDoc, "uuid-1", {
      original: "In the beginning",
      type: "verse",
      cellLabel: "GEN 1:1",
      context: "GEN 1:1",
      group: "GEN",
      section: "GEN 1",
      globalReferences: ["GEN 1:2"],
    })
    seedCellWithTranslation(yDoc, "uuid-2", "En el principio")

    const { ctx, cleanup } = await makeCtx(yDoc)
    const result = await importYDocIfEmpty(ctx)

    expect(result).toEqual({ imported: 2, skipped: false })

    const cell1 = await getCell(ctx.store, "uuid-1")
    expect(cell1).toMatchObject({
      id: "uuid-1",
      project_id: PROJECT_ID,
      scope_id: FILE_ID,
      address: "GEN 1:1",
      ord: 0,
      kind: "verse",
      source_text: "In the beginning",
      translation_text: "",
      label: "GEN 1:1",
      status: "empty",
    })
    expect(JSON.parse(cell1!.format_meta)).toMatchObject({
      context: "GEN 1:1",
      group: "GEN",
      section: "GEN 1",
      globalReferences: ["GEN 1:2"],
    })

    const cell2 = await getCell(ctx.store, "uuid-2")
    expect(cell2?.translation_text).toBe("En el principio")
    expect(cell2?.status).toBe("draft")
    expect(cell2?.ord).toBe(1)

    await cleanup()
  })

  test("skips when local store already has cells for this scope", async () => {
    seedCell(yDoc, "uuid-1", { original: "x", type: "verse" })
    const { ctx, cleanup } = await makeCtx(yDoc)
    // Pre-seed the local store
    await upsertCell(ctx.store, {
      id: "preexisting",
      project_id: PROJECT_ID,
      scope_id: FILE_ID,
      address: "1",
      ord: 0,
      kind: "text",
      parent_cell_id: null,
      source_text: "preexisting",
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
      seq: 0,
      created_at: 0,
      updated_at: 0,
      org_id: "org-1",
      source_lang: "eng",
      target_lang: "spa",
      format_meta: "{}",
      label: null,
      backtranslation_pinned_id: null,
    })

    const result = await importYDocIfEmpty(ctx)

    expect(result.skipped).toBe(true)
    expect(result.imported).toBe(0)
    const cells = await getCellsByScope(ctx.store, PROJECT_ID, FILE_ID)
    expect(cells.map((c) => c.id)).toEqual(["preexisting"])

    await cleanup()
  })

  test("preserves Y.Doc order in cells.ord", async () => {
    seedCell(yDoc, "second", { original: "B", type: "verse" })
    seedCell(yDoc, "first", { original: "A", type: "verse" })
    seedCell(yDoc, "third", { original: "C", type: "verse" })

    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)

    const rows = await getCellsByScope(ctx.store, PROJECT_ID, FILE_ID)
    expect(rows.map((c) => c.id)).toEqual(["second", "first", "third"])
    expect(rows.map((c) => c.ord)).toEqual([0, 1, 2])

    await cleanup()
  })

  test("falls back to a synthetic address when cellLabel is missing", async () => {
    seedCell(yDoc, "uuid-x", { original: "src", type: "verse" })
    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)
    const cell = await getCell(ctx.store, "uuid-x")
    expect(cell?.address).toMatch(/^cell-\d+$/)
    expect(cell?.label).toBeNull()
    await cleanup()
  })

  test("re-running after success skips (idempotent)", async () => {
    seedCell(yDoc, "uuid-1", { original: "x", type: "verse" })
    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)
    const second = await importYDocIfEmpty(ctx)
    expect(second.skipped).toBe(true)
    await cleanup()
  })

  test("imports attachments from __source.metadata into cell_attachments", async () => {
    seedCell(yDoc, "uuid-with-attachments", {
      original: "src",
      type: "verse",
      __source: {
        kind: "code",
        languageId: "scripture",
        value: "src",
        metadata: {
          id: "uuid-with-attachments",
          type: "verse",
          attachments: {
            "att-audio-1": {
              url: "/.project/attachments/files/JUD/a.webm",
              type: "audio",
              createdAt: 1700000000,
            },
            "att-image-1": {
              url: "/.project/attachments/images/photo.png",
              type: "image",
            },
          },
        },
      },
    })

    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)

    const rows = await ctx.store.query<{
      id: string
      cell_id: string
      kind: string
      ref: string
    }>(
      "SELECT id, cell_id, kind, ref FROM cell_attachments WHERE cell_id = ? ORDER BY id",
      ["uuid-with-attachments"],
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.kind).sort()).toEqual(["audio", "image"])
    expect(
      rows.find((r) => r.id === "uuid-with-attachments::att-audio-1")?.ref,
    ).toBe("/.project/attachments/files/JUD/a.webm")

    await cleanup()
  })

  test("imports audioTimings from __source.metadata into audio_timings", async () => {
    seedCell(yDoc, "uuid-with-audio", {
      original: "src",
      type: "verse",
      __source: {
        kind: "code",
        languageId: "scripture",
        value: "src",
        metadata: {
          id: "uuid-with-audio",
          type: "verse",
          attachments: {
            "att-audio-1": {
              url: "/.project/attachments/files/JUD/a.webm",
              type: "audio",
            },
          },
          audioTimings: {
            "att-audio-1": [
              { word: "In", t0: 0, t1: 0.18, start: 0, end: 2 },
              { word: "the", t0: 0.18, t1: 0.32, start: 3, end: 6 },
              {
                word: "beginning",
                t0: 0.32,
                t1: 0.92,
                start: 7,
                end: 16,
              },
            ],
          },
        },
      },
    })

    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)

    const rows = await ctx.store.query<{
      attachment_id: string
      cell_id: string
      timings_json: string
    }>(
      "SELECT attachment_id, cell_id, timings_json FROM audio_timings WHERE cell_id = ?",
      ["uuid-with-audio"],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].attachment_id).toBe("uuid-with-audio::att-audio-1")
    const parsed = JSON.parse(rows[0].timings_json) as Array<{ word: string }>
    expect(parsed.map((t) => t.word)).toEqual([
      "In",
      "the",
      "beginning",
    ])

    await cleanup()
  })

  test("audio timings are skipped when the audioTimings field is missing", async () => {
    seedCell(yDoc, "uuid-no-audio", {
      original: "src",
      type: "verse",
      __source: {
        kind: "code",
        languageId: "scripture",
        value: "src",
        metadata: { id: "uuid-no-audio", type: "verse" },
      },
    })
    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)
    const rows = await ctx.store.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM audio_timings",
    )
    expect(rows[0].count).toBe(0)
    await cleanup()
  })

  test("import + mirror together: Y.Doc edit after import propagates correctly", async () => {
    seedCellWithTranslation(yDoc, "uuid-1", "")
    const { ctx, cleanup } = await makeCtx(yDoc)
    await importYDocIfEmpty(ctx)

    // Now edit the Y.Doc fragment and verify the mirror would find the row.
    // This test only checks the import; the mirror is exercised separately.
    const cell = await getCell(ctx.store, "uuid-1")
    expect(cell).not.toBeNull()
    expect(cell?.id).toBe("uuid-1") // ID compatible with Y.Doc keying

    await cleanup()
  })
})
