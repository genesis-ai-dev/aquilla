/**
 * AQU-1694 — Who's Who on a gateway-language source, through the word bridges.
 *
 * Real Bible Knowledge Pack data (JHN 4) and the real BSB text of John 4 with
 * a real Bridge 1 alignment (src/lib/bible-data/__fixtures__/bridge-jhn4.*),
 * served by a stubbed fetch the way the sync-worker's
 * source-word-alignment route serves it. The table must
 *   • tint the words of an English source that refer to someone, and light a
 *     participant's thread across the rows on hover, as it does for Greek;
 *   • draw a word the alignment is unsure of as approximate (dotted), and
 *     every word of a short book so;
 *   • tint nothing in a cell whose source text changed since it was aligned;
 *   • light the same participant's words in the target column, through
 *     Bridge 2, when one of their source words is hovered;
 *   • read no alignment and tint nothing when Who's Who, or the person's
 *     highlights, are off, or unless this device has the Bible data
 *     experiment on and a Bible is open (AQU-1685).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { __resetSourceAlignmentStore } from "./bible-data/source-alignment-store"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { bridgeJhn4, bridgeJhn4Text } from "@/lib/bible-data/__fixtures__/bridge-jhn4"
import { JESUS, JHN4_PEOPLE_JSON, JHN4_STRUCTURE_JSON, JHN4_TEXT_JSON, SAMARITAN_WOMAN } from "@/lib/bible-data/__fixtures__/jhn4"
import { __resetBridgeModelForTests } from "@/lib/bible-data/bridge-align-protocol"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import { alignSourceBook } from "@/lib/bible-data/source-alignment"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests, setBibleDataViewPrefs } from "@/lib/store/bible-data-view-prefs"
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
      // The store holds all of John 4 (Bridge 2 learns from it); the screen
      // shows its first rows, as a virtualized list would.
      return React.createElement(
        "div",
        null,
        data.slice(0, 12).map((item, index) =>
          React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? item }, renderItem({ item, index })),
        ),
      )
    }),
  }
})

// Each test renders an editor over a 54-verse chapter: give it a stall
// watchdog, not a speed bar (AGENTS.md rule 15).
vi.setConfig({ testTimeout: 30_000 })

const FILE_ID = "file-jhn"
const VERSES = bridgeJhn4()
const cellIdFor = (ref: string) => `cell-${ref.slice(4).replace(":", "-")}`
const BSB = new Map(VERSES.map((verse) => [verse.ref, verse.bsb]))

// The alignment a maintainer's run would have stored for this file.
const ALIGNED = alignSourceBook(
  bridgeJhn4Text(VERSES),
  VERSES.map((verse) => ({ cellId: cellIdFor(verse.ref), refs: [verse.ref], text: verse.bsb })),
)!

let storedTrainedPairs = 878
const storedAlignment = () => ({
  cells: ALIGNED.cells.map((cell) => ({
    cellId: cell.cellId,
    sourceHash: cell.sourceHash,
    method: "ibm1-gdfa-names/1",
    trainedPairs: storedTrainedPairs,
    stale: false,
    links: cell.links.map((link) => [link.wordId, link.token, Math.floor(link.conf * 1000) / 1000]),
  })),
})

const MANIFEST = {
  pack: "bkp",
  version: "1.0.0",
  builtAt: "2026-10-06T03:39:26.174Z",
  versification: "org",
  sources: [],
  layers: {},
  books: { JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
}
const FILES: Readonly<Record<string, string>> = {
  "/people/JHN.json": JHN4_PEOPLE_JSON,
  "/text/JHN.json": JHN4_TEXT_JSON,
  "/structure/JHN.json": JHN4_STRUCTURE_JSON,
}

const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/source-word-alignment")) return Response.json(storedAlignment())
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})
const alignmentReads = () =>
  fetchMock.mock.calls.filter(([input]) => new URL(input).pathname.endsWith("/source-word-alignment")).length

/** JHN 4 with the BSB as source; the target follows it word for word (enough for Bridge 2 to learn from). */
function makeRows(sourceFor: (ref: string) => string = (ref) => BSB.get(ref)!): CellRow[] {
  return VERSES.flatMap((verse) => {
    const id = cellIdFor(verse.ref)
    const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: verse.ref, anchorCellId: null, wordCount: 1 }
    return [
      { ...shared, side: "source", value: sourceFor(verse.ref), eventId: `${id}-s`, sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false },
      { ...shared, side: "target", value: verse.bsb, eventId: `${id}-t`, sourceEventId: `${id}-s`, lastEditor: "tester", lastEditAt: 2, validated: false },
    ] satisfies CellRow[]
  })
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Injil Yohanes",
    sourceLanguage: "en",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    // AQU-1685: this device switched on the Bible data experiment.
    experimentalFlags: { bibleData: true },
    ...overrides,
  }
}

/** `bibleOpen` is what ProjectWorkspace passes: true while the editor shows a scripture file. */
function renderTable(project: ProjectRecord, rows: CellRow[] = makeRows(), bibleOpen = true) {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: FILE_ID, username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
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
          getTokenForFile={async () => "jwt"}
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
const mentionsIn = (cellId: string) => [...row(cellId).querySelectorAll<HTMLElement>('[data-testid="mention"]')]
const allMentions = () => [...document.querySelectorAll<HTMLElement>('[data-testid="mention"]')]
const mentionWord = (cellId: string, word: RegExp) => {
  const found = mentionsIn(cellId).find((el) => word.test(el.textContent ?? ""))
  if (!found) throw new Error(`no mention ${word} in ${cellId}`)
  return found
}
const JHN_4_7 = cellIdFor("JHN 4:7")
// A stall watchdog, not a speed bar: loading the pack and the alignment and
// rendering 54 rows can take seconds on a busy machine (AGENTS.md rule 15).
const LOAD = { timeout: 10_000 }

async function mentionsLoaded() {
  await waitFor(() => expect(mentionsIn(JHN_4_7).length).toBeGreaterThan(0), LOAD)
}

/** The people layer is in once the Context tab can explain a verse. */
async function packLoaded(cellId: string) {
  fireEvent.click(within(row(cellId)).getByRole("button", { name: "Open cell details" }))
  fireEvent.click(await waitFor(() => within(row(cellId)).getByRole("tab", { name: /Context/ }), LOAD))
  await within(row(cellId)).findByTestId("cell-context-tab", {}, LOAD)
}

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  __resetSourceAlignmentStore()
  __resetBridgeModelForTests()
  storedTrainedPairs = 878
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("an English source, through the stored alignment", () => {
  it("tints the BSB words that refer to someone in JHN 4:7, with the right person", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    // “When a Samaritan woman came …, Jesus said to her, “Give Me a drink.””
    expect(mentionWord(JHN_4_7, /^Jesus$/).dataset.mentionEntity).toBe(JESUS)
    expect(mentionWord(JHN_4_7, /her$/).dataset.mentionEntity).toBe(SAMARITAN_WOMAN)
    expect(mentionWord(JHN_4_7, /^Me$/).dataset.mentionEntity).toBe(JESUS)
  })

  it("lights Jesus's words across the rows when one is hovered, and only his", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    fireEvent.pointerEnter(mentionWord(JHN_4_7, /^Jesus$/))
    // Wait for state, not time (AGENTS.md rule 10): on a busy machine the rows
    // can still be settling when the pointer arrives.
    await waitFor(() => {
      const lit = allMentions().filter((el) => el.dataset.mentionLit === "true")
      expect(lit.length).toBeGreaterThan(3)
      expect(new Set(lit.map((el) => el.dataset.mentionEntity))).toEqual(new Set([JESUS]))
    }, LOAD)
  })

  it("draws the words the alignment is unsure of as approximate, and says so", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    const words = allMentions()
    const approximate = words.filter((el) => el.dataset.mentionApproximate === "true")
    expect(approximate.length).toBeGreaterThan(0)
    expect(approximate.length).toBeLessThan(words.length)
    expect(approximate[0].getAttribute("aria-label")).toMatch(/probably/)
    act(() => approximate[0].focus())
    expect((await screen.findByTestId("mention-placement", {}, LOAD)).textContent).toMatch(/^Approximate/)
  })

  it("draws every word of a short book as approximate", async () => {
    storedTrainedPairs = 54
    renderTable(makeProject())
    await mentionsLoaded()
    expect(allMentions().every((el) => el.dataset.mentionApproximate === "true")).toBe(true)
  })

  it("tints nothing in a verse whose source text changed after it was aligned", async () => {
    renderTable(makeProject(), makeRows((ref) => (ref === "JHN 4:7" ? BSB.get(ref)!.replace("Jesus", "Yeshua") : BSB.get(ref)!)))
    await waitFor(() => expect(mentionsIn(cellIdFor("JHN 4:9")).length).toBeGreaterThan(0), LOAD)
    expect(mentionsIn(JHN_4_7)).toEqual([])
  })
})

describe("the target column, through Bridges 1+2", () => {
  const painted = new Map<string, Range[]>()
  class FakeHighlight {
    ranges: Range[]
    constructor(...ranges: Range[]) {
      this.ranges = ranges
    }
  }

  beforeEach(() => {
    painted.clear()
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: FakeHighlight) => painted.set(name, highlight.ranges),
        delete: (name: string) => painted.delete(name),
      },
    })
    vi.stubGlobal("Highlight", FakeHighlight)
  })

  it("lights Jesus's words in the target text of the rows on screen when his source word is hovered", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    fireEvent.pointerEnter(mentionWord(JHN_4_7, /^Jesus$/))
    await waitFor(() => {
      const lit = [...(painted.get("aq-mention-lit") ?? []), ...(painted.get("aq-mention-lit-approx") ?? [])]
      expect(lit.map((range) => range.toString())).toContain("Jesus")
    }, LOAD)
    const target = row(JHN_4_7).querySelector("[data-target-read-view]")!
    const lit = [...(painted.get("aq-mention-lit") ?? []), ...(painted.get("aq-mention-lit-approx") ?? [])]
    // Every lit range sits in some row's target text, never in the source column.
    expect(lit.some((range) => target.contains(range.startContainer))).toBe(true)
    expect(lit.every((range) => range.startContainer.parentElement?.closest("[data-target-read-view]"))).toBe(true)
  })
})

describe("off means off", () => {
  it("reads no alignment and tints nothing when Who's Who is off", async () => {
    renderTable(makeProject({ bibleEnrichments: { "whos-who": false } }))
    await packLoaded(JHN_4_7)
    expect(alignmentReads()).toBe(0)
    expect(allMentions()).toEqual([])
  })

  // AQU-1685: the experiment is device-local and off by default, and any
  // other EditorTable mount passes no `bibleOpen`. Either way neither bridge
  // runs: no stored alignment is read and no pack file is fetched.
  it.each([
    ["with the Bible data experiment off", { experimentalFlags: {} }, true],
    ["when no Bible is open", {}, false],
  ] as const)("reads no alignment, fetches nothing and tints nothing %s", async (_, overrides, bibleOpen) => {
    renderTable(makeProject(overrides), makeRows(), bibleOpen)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(allMentions()).toEqual([])
  })

  it("reads no alignment and tints nothing when the person turns highlights off", async () => {
    act(() => setBibleDataViewPrefs({ whosWhoHighlights: "off" }))
    renderTable(makeProject())
    await packLoaded(JHN_4_7)
    expect(alignmentReads()).toBe(0)
    expect(allMentions()).toEqual([])
  })
})
