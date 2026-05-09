/**
 * useCellsLocal: synchronous-shaped read hook over the local SQLite store
 * for cells in a given (projectId, scopeId). Re-renders when the
 * relevant tables fire store-events.
 */

import { describe, expect, test } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  appendThreadMessage,
  LocalStoreProvider,
  storeEvents,
  upsertCell,
  upsertThread,
  upsertWaiver,
  useProjectStore,
  type CellRow,
  type ThreadRow,
  type WaiverRow,
} from "@/lib/local-store"
import { useCellsLocal } from "./useCellsLocal"

const NOW = 1_700_000_000_000

function wrap({ children }: { children: ReactNode }) {
  return (
    <LocalStoreProvider projectId=":memory:">{children}</LocalStoreProvider>
  )
}

function makeCell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    id: "p1:c1",
    project_id: "p1",
    scope_id: "s1",
    address: "c1",
    ord: 0,
    kind: "verse",
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
    created_at: NOW,
    updated_at: NOW,
    org_id: "org-1",
    source_lang: "eng",
    target_lang: "spa",
    format_meta: "{}",
    label: null,
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

function makeWaiver(overrides: Partial<WaiverRow> = {}): WaiverRow {
  return {
    id: "p1:c1::r1",
    cell_id: "p1:c1",
    cell_version_at: 0,
    text_snapshot: "",
    rule_id: "r1",
    state: "approved",
    justification: "ok",
    proposed_by: "u1",
    proposed_at: NOW,
    resolved_by: "u1",
    resolved_at: NOW,
    seq: 1,
    org_id: "org-1",
    ...overrides,
  }
}

describe("useCellsLocal", () => {
  test("returns empty array initially, then populates from local-store", async () => {
    const { result } = renderHook(
      () => {
        const store = useProjectStore()
        const cells = useCellsLocal(store, "p1", "s1")
        return { store, cells }
      },
      { wrapper: wrap },
    )

    await waitFor(() => {
      expect(result.current.store).not.toBeNull()
    })

    expect(result.current.cells).toEqual([])

    // Insert a cell, expect the hook to update.
    await upsertCell(result.current.store!, makeCell())
    await waitFor(() => {
      expect(result.current.cells).toHaveLength(1)
    })
    expect(result.current.cells[0]).toMatchObject({
      id: "p1:c1",
      original: "src",
      translated: "",
    })
  })

  test("re-renders when a cell's translation_text changes", async () => {
    const { result } = renderHook(
      () => {
        const store = useProjectStore()
        const cells = useCellsLocal(store, "p1", "s1")
        return { store, cells }
      },
      { wrapper: wrap },
    )
    await waitFor(() => expect(result.current.store).not.toBeNull())

    await upsertCell(result.current.store!, makeCell({ translation_text: "" }))
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    await upsertCell(
      result.current.store!,
      makeCell({ translation_text: "Hola", version: 1 }),
    )
    await waitFor(() => {
      expect(result.current.cells[0].translated).toBe("Hola")
    })
    expect(result.current.cells[0].version).toBe(1)
  })

  test("re-renders when a thread is added to a cell", async () => {
    const { result } = renderHook(
      () => {
        const store = useProjectStore()
        const cells = useCellsLocal(store, "p1", "s1")
        return { store, cells }
      },
      { wrapper: wrap },
    )
    await waitFor(() => expect(result.current.store).not.toBeNull())
    await upsertCell(result.current.store!, makeCell())
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].threads).toEqual([])

    await upsertThread(result.current.store!, makeThread())
    await appendThreadMessage(result.current.store!, {
      id: "m1",
      thread_id: "th-1",
      author_id: "u1",
      body: "first",
      created_at: NOW,
      seq: 1,
    })
    await waitFor(() => {
      expect(result.current.cells[0].threads).toHaveLength(1)
    })
    expect(result.current.cells[0].threads[0].messages[0].body).toBe("first")
  })

  test("re-renders when a waiver is added; surfaces is_stale flag", async () => {
    const { result } = renderHook(
      () => {
        const store = useProjectStore()
        const cells = useCellsLocal(store, "p1", "s1")
        return { store, cells }
      },
      { wrapper: wrap },
    )
    await waitFor(() => expect(result.current.store).not.toBeNull())
    await upsertCell(result.current.store!, makeCell({ version: 5 }))
    await waitFor(() => expect(result.current.cells).toHaveLength(1))

    await upsertWaiver(
      result.current.store!,
      makeWaiver({ cell_version_at: 3 }),
    )
    await waitFor(() => {
      expect(result.current.cells[0].waivers).toHaveLength(1)
    })
    expect(result.current.cells[0].waivers[0].is_stale).toBe(true)
  })

  test("scopes by projectId + scopeId — other scopes are filtered", async () => {
    const { result } = renderHook(
      () => {
        const store = useProjectStore()
        const cells = useCellsLocal(store, "p1", "s1")
        return { store, cells }
      },
      { wrapper: wrap },
    )
    await waitFor(() => expect(result.current.store).not.toBeNull())

    await upsertCell(result.current.store!, makeCell({ id: "p1:a", scope_id: "s1" }))
    await upsertCell(result.current.store!, makeCell({ id: "p1:b", scope_id: "s2" }))
    await waitFor(() => expect(result.current.cells).toHaveLength(1))
    expect(result.current.cells[0].id).toBe("p1:a")
  })

  test("does not subscribe when the store is null (provider still loading)", () => {
    // Drop existing listeners so we can count them precisely.
    storeEvents.reset()
    const initialListeners = countListeners()
    renderHook(() => useCellsLocal(null, "p1", "s1"))
    expect(countListeners()).toBe(initialListeners)
  })
})

function countListeners(): number {
  // Fire a probe event and count synchronous receivers via a sentinel.
  let count = 0
  const probe = storeEvents.subscribe(() => {
    count++
  })
  storeEvents.emit({ type: "cells.changed" })
  probe()
  return Math.max(0, count - 1)
}
