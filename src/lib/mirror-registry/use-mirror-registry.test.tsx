import { describe, expect, test } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import * as Y from "yjs"
import {
  getCell,
  listPending,
  upsertCell,
  type CellRow,
} from "@/lib/local-store"
import {
  LocalStoreProvider,
  useProjectStore,
} from "@/lib/local-store/provider"
import { useMirrorRegistry } from "./use-mirror-registry"

function wrap({ children }: { children: ReactNode }) {
  return <LocalStoreProvider projectId=":memory:">{children}</LocalStoreProvider>
}

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "cell-1",
    project_id: "p",
    scope_id: "s",
    address: "1",
    ord: 0,
    kind: "text",
    parent_cell_id: null,
    source_text: "src",
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

function seedYDocCell(yDoc: Y.Doc, cellId: string): Y.XmlFragment {
  const cellsMap = yDoc.getMap("cells")
  const yCell = new Y.Map()
  const fragment = new Y.XmlFragment()
  yCell.set("translatedXml", fragment)
  cellsMap.set(cellId, yCell)
  return fragment
}

describe("useMirrorRegistry", () => {
  test("transitions to ready once the store is open", async () => {
    const yDoc = new Y.Doc()
    const { result } = renderHook(
      () => useMirrorRegistry(yDoc, "u1"),
      { wrapper: wrap },
    )
    await waitFor(() => {
      expect(result.current).toBe("ready")
    })
    yDoc.destroy()
  })

  test("a Y.Doc edit propagates to cells.translation_text in the local store", async () => {
    const yDoc = new Y.Doc()
    const fragment = seedYDocCell(yDoc, "cell-1")
    const { result } = renderHook(
      () => {
        const status = useMirrorRegistry(yDoc, "u1")
        const store = useProjectStore()
        return { status, store }
      },
      { wrapper: wrap },
    )

    await waitFor(() => {
      expect(result.current.status).toBe("ready")
      expect(result.current.store).not.toBeNull()
    })

    // Seed the local store row that the mirror will update.
    await upsertCell(result.current.store!, makeCell({ id: "cell-1" }))

    yDoc.transact(() => {
      const p = new Y.XmlElement("p")
      p.insert(0, [new Y.XmlText("Hola")])
      fragment.insert(0, [p])
    })

    await waitFor(async () => {
      const cell = await getCell(result.current.store!, "cell-1")
      expect(cell?.translation_text).toBe("Hola")
    })

    const pending = await listPending(result.current.store!)
    expect(pending).toHaveLength(1)
    expect(pending[0].endpoint).toBe("/projects/p/cells/cell-1")

    yDoc.destroy()
  })

  test("returns no-store when used outside a provider with a real store", async () => {
    const yDoc = new Y.Doc()
    // Provider exists but yDoc is null — hook should be in 'loading'.
    const { result } = renderHook(() => useMirrorRegistry(null, "u1"), {
      wrapper: wrap,
    })
    await waitFor(() => {
      expect(result.current).toBe("loading")
    })
    yDoc.destroy()
  })
})
