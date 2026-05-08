/**
 * Forward-compatibility contract: server may add fields to its responses
 * (snapshot records, change broadcasts) without breaking older clients.
 * Unknown fields are silently dropped at the boundary.
 *
 * See DATA_PERSISTENCE_PLAN.md §13 — tolerant readers on both sides.
 */

import { describe, expect, test } from "vitest"
import { applyChangeBatch } from "./sync"
import { getCell, type CellRow } from "./cells"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import { getProjectMeta, upsertProjectMeta } from "./project-meta"
import { ingestSnapshot } from "./snapshot"

async function* asLines(arr: string[]): AsyncIterable<string> {
  for (const line of arr) yield line
}

const PROJECT_ID = "p1"

const META = {
  type: "snapshot_meta",
  snapshot_seq: 1,
  project_id: PROJECT_ID,
  generated_at: 0,
}

const PROJECT = {
  type: "project_meta",
  project_id: PROJECT_ID,
  org_id: "o",
  name: "Demo",
  library_doc_id: "l",
  bound_version_id: "v",
  source_lang: "eng",
  target_lang: "spa",
}

const CELL = {
  type: "cell",
  id: "p1:c.1",
  project_id: PROJECT_ID,
  scope_id: "s",
  address: "c.1",
  ord: 0,
  kind: "text",
  parent_cell_id: null,
  source_text: "hello",
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
}

describe("forward compatibility — unknown fields are tolerated", () => {
  test("ingestSnapshot ignores unknown fields on snapshot_meta", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
    try {
      const lines = [
        JSON.stringify({ ...META, future_field: "from-the-future" }),
        JSON.stringify(PROJECT),
        JSON.stringify(CELL),
      ]
      const result = await ingestSnapshot(store, asLines(lines))
      expect(result.snapshotSeq).toBe(1)
      expect(await getCell(store, "p1:c.1")).not.toBeNull()
    } finally {
      await store.close()
    }
  })

  test("ingestSnapshot ignores unknown fields on project_meta", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
    try {
      const lines = [
        JSON.stringify(META),
        JSON.stringify({
          ...PROJECT,
          future_setting: { complex: "nested" },
          ai_model_default: "claude-opus-4-7",
        }),
      ]
      await ingestSnapshot(store, asLines(lines))
      const meta = await getProjectMeta(store, PROJECT_ID)
      expect(meta?.name).toBe("Demo")
      // Extra fields don't appear in our typed projection — that's the point.
      expect(meta).not.toHaveProperty("future_setting")
    } finally {
      await store.close()
    }
  })

  test("ingestSnapshot ignores unknown fields on cell records", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
    try {
      const lines = [
        JSON.stringify(META),
        JSON.stringify(PROJECT),
        JSON.stringify({
          ...CELL,
          embedding: [0.1, 0.2, 0.3],
          ml_classification: "narrative",
        }),
      ]
      await ingestSnapshot(store, asLines(lines))
      const cell = await getCell(store, "p1:c.1")
      expect(cell?.source_text).toBe("hello")
    } finally {
      await store.close()
    }
  })

  test("applyChangeBatch ignores unknown fields on incoming cell rows", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
    try {
      await upsertProjectMeta(store, {
        project_id: PROJECT_ID,
        org_id: "o",
        name: "Demo",
        library_doc_id: "l",
        bound_version_id: "v",
        source_lang: "eng",
        target_lang: "spa",
        last_seq: 0,
        snapshot_seq: null,
        loaded_at: 0,
      })
      const cellWithExtras = {
        ...CELL,
        embedding: [0.1, 0.2],
        provenance: { reviewer_id: "u1" },
      } as unknown as CellRow
      await applyChangeBatch(store, {
        project_id: PROJECT_ID,
        seq: 5,
        cells: [cellWithExtras],
      })
      const cell = await getCell(store, "p1:c.1")
      expect(cell?.source_text).toBe("hello")
      expect(cell).not.toHaveProperty("embedding")
    } finally {
      await store.close()
    }
  })

  test("ingestSnapshot fails loudly on unknown record TYPES — additive policy is per-field, not per-type", async () => {
    const store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
    try {
      const lines = [
        JSON.stringify(META),
        JSON.stringify(PROJECT),
        JSON.stringify({ type: "unknown_record_kind", something: "?" }),
      ]
      await expect(
        ingestSnapshot(store, asLines(lines)),
      ).rejects.toThrow(/unknown snapshot record type/)
    } finally {
      await store.close()
    }
  })
})
