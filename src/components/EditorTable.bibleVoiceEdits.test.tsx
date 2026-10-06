/**
 * AQU-1692 — the Voices follow-ups in the editor, through the real pack client
 * on real Bible Knowledge Pack 1.2.0 data for Ruth
 * (src/lib/bible-data/__fixtures__/ot-pack12.ts). What it protects, from
 * aquilla-specs 05-user-stories/see-who-is-speaking.md (Error / edge cases):
 *   • where the data is unsure who speaks (RUT 1:10: FCBH and Macula disagree),
 *     the chip marks the speaker "check" and the popover says why; a sure
 *     speaker (RUT 1:8) is not marked, or the marker would mean nothing;
 *   • a speech whose boundary scholars dispute is marked on the chip itself,
 *     not only in the popover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { OT_PACK12_FILES, OT_PACK12_MANIFEST, RUTH_SPEECH_1_16 } from "@/lib/bible-data/__fixtures__/ot-pack12"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { BkpVoicesLayer } from "@/lib/bible-data/pack-types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"
import type { CellRow } from "@/lib/sync/cells-read-types"

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react")
  return {
    LegendList: React.forwardRef(function MockLegendList(
      {
        data,
        renderItem,
        keyExtractor,
      }: {
        data: string[]
        renderItem: (props: { item: string; index: number }) => ReactNode
        keyExtractor?: (item: string, index: number) => string
      },
      ref,
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: () => ({ scroll: 0, positionAtIndex: (i: number) => i * 140, sizeAtIndex: () => 140 }),
        scrollToIndex: async () => undefined,
        scrollToOffset: async () => undefined,
      }))
      return React.createElement(
        "div",
        null,
        data.map((item, index) =>
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
        ),
      )
    }),
  }
})

// ── The pack, served by a stubbed fetch ─────────────────────────────────────

let files: Record<string, string> = { ...OT_PACK12_FILES }
let offline = false
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  if (offline) throw new TypeError("Failed to fetch")
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(OT_PACK12_MANIFEST)
  const file = Object.entries(files).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

// ── A Ruth file ─────────────────────────────────────────────────────────────

const VERSES = ["1:8", "1:9", "1:10", "1:16", "1:17", "2:2", "2:7"] as const
const rut = (verse: string) => `cell-RUT-${verse.replace(":", "-")}`

function makeRows(metadata: Record<string, Record<string, unknown>>): CellRow[] {
  return VERSES.flatMap((verse) => {
    const id = rut(verse)
    const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: `RUT ${verse}`, anchorCellId: null, wordCount: 1 }
    return [
      { ...shared, side: "source", value: `source ${verse}`, eventId: `${id}-source`, sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false, ...(metadata[id] ? { metadata: metadata[id] } : {}) },
      { ...shared, side: "target", value: `target ${verse}`, eventId: `${id}-target`, sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false },
    ] satisfies CellRow[]
  })
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Rut",
    sourceLanguage: "hbo",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: "file-RUT", name: "RUT", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    // AQU-1685: this device switched on the Bible data experiment.
    experimentalFlags: { bibleData: true },
    ...overrides,
  }
}

interface RenderOptions {
  project?: ProjectRecord
  bibleOpen?: boolean
  metadata?: Record<string, Record<string, unknown>>
}

function renderRuth({ project = makeProject(), bibleOpen = true, metadata = {} }: RenderOptions = {}) {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: "file-RUT", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(metadata), { full: true, maxServerSeq: 1 })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={project}
          cellStore={store}
          username="tester"
          isCompletionConfigured={false}
          isCompletionAvailable={false}
          completing={new Map()}
          examples={new Map()}
          errors={new Map()}
          previews={new Map()}
          onCompleteSingle={() => {}}
          onCompleteBatch={() => {}}
          healthMap={new Map()}
          lineNumbersEnabled={false}
          cellLabelsEnabled
          sourceTextDirection="ltr"
          targetTextDirection="ltr"
          bibleOpen={bibleOpen}
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

function row(cellId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"][data-index]`)
  if (!el) throw new Error(`no row ${cellId}`)
  return el
}

function chipIn(cellId: string): HTMLElement | null {
  return row(cellId).querySelector<HTMLElement>('[data-testid="voice-chip"]')
}

async function chip(cellId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = chipIn(cellId)
    if (!found) throw new Error(`no chip in ${cellId} yet`)
    return found
  })
}

/** Bidi isolates are invisible; strip them to compare names. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

async function openDetails(cellId: string): Promise<HTMLElement> {
  const trigger = await chip(cellId)
  act(() => trigger.focus())
  return screen.findByTestId("voice-details")
}

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  files = { ...OT_PACK12_FILES }
  offline = false
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a speaker the data is unsure of", () => {
  it("is marked 'check' on the chip and in the popover where the sources disagree, and not where they agree", async () => {
    renderRuth()
    const unsure = await chip(rut("1:10"))
    expect(unsure.querySelector("[data-voice-check]")).not.toBeNull()
    expect(visible(unsure.getAttribute("aria-label"))).toBe("Who is speaking: Narrator, Orpah to Naomi (speaker needs checking)")

    const sure = await chip(rut("1:8"))
    expect(sure.querySelector("[data-voice-check]")).toBeNull()

    const details = await openDetails(rut("1:10"))
    expect(within(details).getByTestId("speaker-check").textContent).toBe("Check")
    expect(details.textContent).toContain("The sources disagree about who is speaking.")
  })

  it("is marked where no source names the speaker at all (RUT 2:7)", async () => {
    renderRuth()
    const details = await openDetails(rut("2:7"))
    expect(details.textContent).toContain("No source names the speaker.")
  })
})

describe("a disputed speech boundary", () => {
  it("is marked on the chip of every cell the speech is in, and on no other", async () => {
    const voices = JSON.parse(OT_PACK12_FILES["/voices/RUT.json"]) as BkpVoicesLayer
    const ruth = voices.speeches.find((speech) => speech.id === RUTH_SPEECH_1_16)
    if (!ruth) throw new Error("no RUT 1:16 speech")
    ruth.disputed = { reason: "Where Ruth's vow ends is disputed (synthetic).", source: "test" }
    files["/voices/RUT.json"] = JSON.stringify(voices)
    renderRuth()

    for (const verse of ["1:16", "1:17"]) {
      const marked = await chip(rut(verse))
      expect(marked.getAttribute("data-voice-disputed"), verse).toBe("true")
      expect(visible(marked.getAttribute("aria-label")), verse).toMatch(/, boundary disputed$/)
    }
    expect((await chip(rut("1:8"))).getAttribute("data-voice-disputed")).toBeNull()
  })
})
