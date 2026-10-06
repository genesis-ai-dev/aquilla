/**
 * AQU-1687 — Voices in the editor: who speaks in each Bible cell.
 *
 * The story under test is aquilla-specs 05-user-stories/see-who-is-speaking.md,
 * end to end through the real pack client: a stubbed fetch serves real Bible
 * Knowledge Pack data for JHN 4 (src/lib/bible-data/__fixtures__), and the
 * table must show
 *   • each cell's voices in reading order in the row-corner slot, while a
 *     dubbing cast name or an assigned voice keeps that slot;
 *   • speech rails whose caps mark where a quotation opens and closes;
 *   • the details on keyboard focus, with "Show every line by …" filtering
 *     the rows and a visible way back;
 *   • nothing at all, and nothing fetched, when the Voices enrichment is off,
 *     and live removal when it is switched off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { JHN4_PEOPLE_JSON, JHN4_VOICES_JSON } from "@/lib/bible-data/__fixtures__/jhn4"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import {
  resetBibleDataViewPrefsCacheForTests,
  setBibleDataViewPrefs,
} from "@/lib/store/bible-data-view-prefs"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { Concept } from "@/lib/terminology/types"

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

const MANIFEST = {
  pack: "bkp",
  version: "1.0.0",
  builtAt: "2026-10-06T03:39:26.174Z",
  versification: "org",
  sources: [],
  layers: {},
  books: { JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
}

let offline = false
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  if (offline) throw new TypeError("Failed to fetch")
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  if (path.endsWith("/voices/JHN.json")) return new Response(JHN4_VOICES_JSON, { status: 200 })
  if (path.endsWith("/people/JHN.json")) return new Response(JHN4_PEOPLE_JSON, { status: 200 })
  return new Response("missing", { status: 404 })
})
const layerFetches = () =>
  fetchMock.mock.calls.map(([input]) => new URL(input).pathname).filter((path) => !path.endsWith("manifest.json"))

// ── A JHN 4 file ────────────────────────────────────────────────────────────

const VERSES = ["4:7", "4:8", "4:9", "4:10", "4:34", "4:35", "4:36", "4:38"] as const
const cellIdFor = (verse: string) => `cell-${verse.replace(":", "-")}`

interface CellSpec {
  id: string
  ref: string
  type?: string
  metadata?: Record<string, unknown>
}

const DEFAULT_CELLS: CellSpec[] = [
  { id: "heading", ref: "JHN 4:s:1", type: "heading" },
  ...VERSES.map((verse) => ({ id: cellIdFor(verse), ref: `JHN ${verse}` })),
]

function makeRows(cells: readonly CellSpec[]): CellRow[] {
  return cells.flatMap(({ id, ref, type = "text", metadata }, i) => [
    {
      cellId: id,
      side: "source",
      value: `source ${i}`,
      valueHtml: null,
      type,
      canonicalRef: ref,
      anchorCellId: null,
      eventId: `${id}-source`,
      sourceEventId: null,
      lastEditor: null,
      lastEditAt: 1,
      validated: false,
      wordCount: 1,
      ...(metadata ? { metadata } : {}),
    },
    {
      cellId: id,
      side: "target",
      value: `target ${i}`,
      valueHtml: null,
      type,
      canonicalRef: ref,
      anchorCellId: null,
      eventId: `${id}-target`,
      sourceEventId: `${id}-source`,
      lastEditor: "tester",
      lastEditAt: 2,
      validated: false,
      wordCount: 1,
    },
  ] satisfies CellRow[])
}

function makeStore(cells: readonly CellSpec[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "proj-1",
    fileId: "file-jhn",
    username: "tester",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Injil Yohanes",
    sourceLanguage: "en",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    // A scripture file: Bible data is on by its derived default.
    files: [{ id: "file-jhn", name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    ...overrides,
  }
}

function renderTable(project: ProjectRecord, cells: readonly CellSpec[] = DEFAULT_CELLS) {
  const store = makeStore(cells)
  const qc = new QueryClient()
  const ui = (p: ProjectRecord) => (
    <QueryClientProvider client={qc}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={p}
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
        />
      </EditorActionsProvider>
    </QueryClientProvider>
  )
  const view = render(ui(project))
  return { rerender: (next: ProjectRecord) => view.rerender(ui(next)) }
}

function row(cellId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"][data-index]`)
  if (!el) throw new Error(`no row ${cellId}`)
  return el
}

function chipIn(cellId: string): HTMLElement | null {
  return row(cellId).querySelector<HTMLElement>('[data-testid="voice-chip"]')
}

/** What a sighted reader sees in the chip, separators included. */
function chipText(cellId: string): string {
  return (chipIn(cellId)?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** Bidi isolates are invisible; strip them to compare names. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

async function voicesLoaded() {
  await waitFor(() => expect(chipIn(cellIdFor("4:7"))).not.toBeNull())
}

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  offline = false
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("voice chips in the row-corner slot", () => {
  it("shows each cell's voices in reading order, from the pack", async () => {
    renderTable(makeProject())
    await voicesLoaded()

    expect(chipText(cellIdFor("4:7"))).toBe("Narrator·Jesus→Samaritan woman")
    expect(chipText(cellIdFor("4:8"))).toBe("Narrator")
    expect(chipText(cellIdFor("4:9"))).toBe("Narrator·Samaritan woman→Jesus·Narrator")
    expect(chipText(cellIdFor("4:10"))).toBe("Narrator·Jesus→Samaritan woman+1")
    // A screen reader hears the same voices in words.
    expect(visible(chipIn(cellIdFor("4:9"))?.getAttribute("aria-label"))).toBe(
      "Who is speaking: Narrator, Samaritan woman to Jesus, Narrator",
    )
  })

  it("isolates names and lets the chip take its own direction (RTL)", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const chip = chipIn(cellIdFor("4:7"))
    expect(chip?.getAttribute("dir")).toBe("auto")
    expect(chip?.querySelectorAll("bdi")).toHaveLength(2)
  })

  it("gives a heading no chip and no rails", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    expect(chipIn("heading")).toBeNull()
    expect(row("heading").querySelector('[data-testid="speech-rails"]')).toBeNull()
  })

  it("marks the cells of a split verse approximate", async () => {
    renderTable(makeProject(), [
      { id: "part-a", ref: "JHN 4:9" },
      { id: "part-b", ref: "JHN 4:9" },
      { id: cellIdFor("4:7"), ref: "JHN 4:7" },
    ])
    await voicesLoaded()
    for (const id of ["part-a", "part-b"]) {
      expect(chipIn(id)?.getAttribute("data-voice-approximate")).toBe("true")
      expect(visible(chipIn(id)?.getAttribute("aria-label"))).toMatch(/^Who is speaking in this verse: /)
    }
    expect(chipIn(cellIdFor("4:7"))?.getAttribute("data-voice-approximate")).toBeNull()
  })
})

describe("the slot belongs to the dubbing cast first", () => {
  it("keeps a cast_name in the slot and shows no voice chip there", async () => {
    const cells = DEFAULT_CELLS.map((cell) =>
      cell.id === cellIdFor("4:7") ? { ...cell, metadata: { cast_name: "Yesus (dubbing)" } } : cell,
    )
    renderTable(makeProject(), cells)
    await waitFor(() => expect(chipIn(cellIdFor("4:9"))).not.toBeNull())

    expect(within(row(cellIdFor("4:7"))).getByTestId("source-cell-label").textContent).toBe("Yesus (dubbing)")
    expect(chipIn(cellIdFor("4:7"))).toBeNull()
    // The rail is not the slot: it still marks the quotation.
    expect(row(cellIdFor("4:7")).querySelector('[data-rail-level="1"]')).not.toBeNull()
  })

  it("keeps an assigned voice in the slot even with cell labels hidden", async () => {
    const project = makeProject({
      ttsSettings: {
        voices: [{ id: "voice-jesus", name: "Jesus voice" }],
        castAssignments: { [cellIdFor("4:7")]: "voice-jesus" },
      },
    })
    renderTable(project)
    await waitFor(() => expect(chipIn(cellIdFor("4:9"))).not.toBeNull())
    expect(chipIn(cellIdFor("4:7"))).toBeNull()
  })
})

describe("speech rails", () => {
  it("caps the rail where Jesus' speech opens (4:34) and closes (4:38), and continues between", async () => {
    renderTable(makeProject())
    await voicesLoaded()

    const level1 = (verse: string) => row(cellIdFor(verse)).querySelector<HTMLElement>('[data-rail-level="1"]')
    expect(level1("4:34")?.dataset).toMatchObject({ railShape: "begin", railCapStart: "true" })
    expect(level1("4:34")?.dataset.railCapEnd).toBeUndefined()
    expect(level1("4:36")?.dataset.railShape).toBe("continue")
    expect(level1("4:36")?.dataset.railCapStart).toBeUndefined()
    expect(level1("4:38")?.dataset).toMatchObject({ railShape: "end", railCapEnd: "true" })
    expect(row(cellIdFor("4:8")).querySelector('[data-testid="speech-rails"]')).toBeNull()

    // Screen readers get the same facts in words.
    expect(visible(within(row(cellIdFor("4:34"))).getByText(/^Speech by/).textContent)).toBe("Speech by Jesus begins")
    expect(visible(within(row(cellIdFor("4:38"))).getByText(/^Speech by/).textContent)).toBe("Speech by Jesus ends")
  })

  it("draws a second, dashed level for a quotation inside a quotation (4:10)", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const level2 = row(cellIdFor("4:10")).querySelector<HTMLElement>('[data-rail-level="2"]')
    expect(level2?.dataset.railShape).toBe("both")
    expect(level2?.style.borderInlineStartStyle).toBe("dashed")
    const level1 = row(cellIdFor("4:10")).querySelector<HTMLElement>('[data-rail-level="1"]')
    expect(level1?.style.borderInlineStartStyle).toBe("solid")
  })
})

describe("details on focus, and 'Show every line by …'", () => {
  it("opens on keyboard focus with the voice's facts and where each name came from", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const chip = chipIn(cellIdFor("4:7"))
    if (!chip) throw new Error("no chip")
    act(() => chip.focus())

    const details = await screen.findByTestId("voice-details")
    const text = visible(details.textContent)
    expect(text).toContain("Conversation")
    expect(text).toContain("Delivery: requesting")
    expect(text).toContain("Quote level 1")
    expect(text).toContain("Speaker: 97% sure, from Clear speaker-quotations and Macula")
    expect(text).toContain("Listener: 80% sure, from Macula (the verb's listener)")
    // Where each name came from.
    expect(text).toContain("JesusFrom ACAI")
    expect(text).toContain("Samaritan womanGenerated, not yet reviewed")
    // Focus stays on the chip: opening on focus does not steal it.
    expect(document.activeElement).toBe(chip)
  })

  it("closes again when keyboard focus moves on", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const first = chipIn(cellIdFor("4:7"))
    const next = chipIn(cellIdFor("4:9"))
    if (!first || !next) throw new Error("no chip")
    act(() => first.focus())
    await screen.findByTestId("voice-details")

    act(() => next.focus())
    // One popover at a time: the first chip's details are gone, the next one's show.
    await waitFor(() => expect(screen.getAllByTestId("voice-details")).toHaveLength(1))
    expect(visible(screen.getByTestId("voice-details").textContent)).toContain("Samaritan woman")
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    await waitFor(() => expect(screen.queryByTestId("voice-details")).toBeNull())
  })

  it("stays open while focus is inside it, and closes when focus leaves it", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const chip = chipIn(cellIdFor("4:7"))
    const elsewhere = chipIn(cellIdFor("4:9"))
    if (!chip || !elsewhere) throw new Error("no chip")
    act(() => chip.focus())
    const action = await screen.findByRole("button", { name: /Show every line by.*Jesus/ })

    // Tab into the popover: it stays open.
    act(() => action.focus())
    expect(screen.getByTestId("voice-details")).toBeTruthy()

    // Then out of it: it closes, and only the newly focused chip's details show.
    act(() => elsewhere.focus())
    await waitFor(() => {
      const open = screen.getAllByTestId("voice-details")
      expect(open).toHaveLength(1)
      expect(visible(open[0].textContent)).toContain("Samaritan woman to Jesus")
    })
  })

  it("opens on hover too", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const chip = chipIn(cellIdFor("4:9"))
    if (!chip) throw new Error("no chip")
    await userEvent.hover(chip)
    const details = await screen.findByTestId("voice-details")
    expect(visible(details.textContent)).toContain("Speaker: 97% sure, from Clear speaker-quotations and Macula")
  })

  it("filters the rows to Jesus' lines, and 'Show all lines' brings the rest back", async () => {
    renderTable(makeProject())
    await voicesLoaded()
    const chip = chipIn(cellIdFor("4:7"))
    if (!chip) throw new Error("no chip")
    act(() => chip.focus())
    fireEvent.click(await screen.findByRole("button", { name: /Show every line by.*Jesus/ }))

    const banner = await screen.findByTestId("voice-filter-banner")
    expect(visible(banner.textContent)).toContain("Showing 6 lines by Jesus")
    const shown = [...document.querySelectorAll("[data-cell-id][data-index]")].map((el) => el.getAttribute("data-cell-id"))
    expect(shown).toEqual(["4:7", "4:10", "4:34", "4:35", "4:36", "4:38"].map(cellIdFor))

    fireEvent.click(within(banner).getByRole("button", { name: "Show all lines" }))
    await waitFor(() => expect(screen.queryByTestId("voice-filter-banner")).toBeNull())
    expect(document.querySelectorAll("[data-cell-id][data-index]")).toHaveLength(DEFAULT_CELLS.length)
  })
})

describe("label language", () => {
  const terminology: Concept[] = [
    {
      id: "c-jesus",
      sourceTerm: "Jesus",
      renderings: [{ rendering: "Yesus", status: "preferred" }],
      status: "active",
      createdAt: "2026-10-05T00:00:00Z",
    },
  ]

  it("shows the project's agreed rendering, and English when the person picks English", async () => {
    renderTable(makeProject({ terminology }))
    await voicesLoaded()
    expect(chipText(cellIdFor("4:7"))).toBe("Narrator·Yesus→Samaritan woman")

    act(() => setBibleDataViewPrefs({ labelMode: "english" }))
    expect(chipText(cellIdFor("4:7"))).toBe("Narrator·Jesus→Samaritan woman")
  })
})

describe("off means off", () => {
  it("shows no chips or rails and fetches no voices when the Voices enrichment is off", async () => {
    renderTable(makeProject({ bibleEnrichments: { voices: false } }))
    // Give a load the chance to happen, then check it did not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-testid="voice-chip"]')).toBeNull()
    expect(document.querySelector('[data-testid="speech-rails"]')).toBeNull()
    // AQU-1689: Who's Who and the Context tab are still on, and read their
    // own layers; Voices' own file is never asked for.
    expect(layerFetches()).not.toContain("/bkp/v1/voices/JHN.json")
  })

  it("fetches nothing when every enrichment the editor shows is off", async () => {
    renderTable(
      makeProject({ bibleEnrichments: { voices: false, "whos-who": false, "original-context": false } }),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(layerFetches()).toEqual([])
  })

  it("shows nothing when Bible data itself is off", async () => {
    renderTable(makeProject({ bibleResourcesEnabled: false }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-testid="voice-chip"]')).toBeNull()
    expect(layerFetches()).toEqual([])
  })

  it("removes chips and rails live when Voices is switched off, without a reload", async () => {
    const { rerender } = renderTable(makeProject())
    await voicesLoaded()
    rerender(makeProject({ bibleEnrichments: { voices: false } }))
    expect(document.querySelector('[data-testid="voice-chip"]')).toBeNull()
    expect(document.querySelector('[data-testid="speech-rails"]')).toBeNull()
  })

  it("hides chips but keeps rails when the person turns voice chips off, and the reverse", async () => {
    renderTable(makeProject())
    await voicesLoaded()

    act(() => setBibleDataViewPrefs({ voiceChips: false }))
    expect(document.querySelector('[data-testid="voice-chip"]')).toBeNull()
    expect(row(cellIdFor("4:7")).querySelector('[data-testid="speech-rails"]')).not.toBeNull()

    act(() => setBibleDataViewPrefs({ voiceChips: true, speechRails: false }))
    expect(chipIn(cellIdFor("4:7"))).not.toBeNull()
    expect(document.querySelector('[data-testid="speech-rails"]')).toBeNull()
  })

  it("shows nothing, and does not throw, when the pack is unreachable", async () => {
    offline = true
    renderTable(makeProject())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-testid="voice-chip"]')).toBeNull()
    expect(row(cellIdFor("4:7"))).toBeTruthy()
  })
})
