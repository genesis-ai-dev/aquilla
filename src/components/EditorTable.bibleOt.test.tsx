/**
 * AQU-1700 — Bible Knowledge Pack 1.2 in the editor: the Old Testament.
 *
 * Through the real pack client over a stubbed fetch serving real pack 1.2.0
 * data for Ruth and Psalm 23 (src/lib/bible-data/__fixtures__/ot-pack12.ts),
 * in a project whose Hebrew source is a Macula import. What it protects, in
 * the translator's terms:
 *   • Voices: RUT 1:16–17 is Ruth speaking to Naomi, and its rails open in
 *     1:16 and close in 1:17, from OT data that has no moves, no vocatives and
 *     no self-projected speech; Psalm 23 is the psalmist's own voice, the
 *     narrator's, with no rails;
 *   • the Context tab lists the verse's Hebrew morphemes right to left, marked
 *     as Hebrew, inside the left-to-right page, with their glosses, who each
 *     refers to, the notes on them (an implied article included) and the
 *     verse's questions; a note on the Ketiv shows its Hebrew right to left;
 *   • the Hebrew source text carries the pack's mentions on the right
 *     morphemes: the suffix ־ִי "me" of RUT 1:16 is Ruth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import {
  DOUBLET_NOTE_1_16,
  IMPLIED_ARTICLE_1_1,
  KETIV_NOTE_1_8,
  LAND_NOTE_1_1,
  ME_1_16,
  OT_PACK12_FILES,
  OT_PACK12_MANIFEST,
  QUESTION_1_16,
  QUOTELESS_NOTE_1_16,
  RUTH,
  maculaHebrewImportText,
  rutNotes,
  rutPeople,
  rutText,
} from "@/lib/bible-data/__fixtures__/ot-pack12"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
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

const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(OT_PACK12_MANIFEST)
  const file = Object.entries(OT_PACK12_FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

// ── A Hebrew source file: Ruth, imported from Macula ────────────────────────

const text = rutText()
const RUT_VERSES = ["1:1", "1:8", "1:14", "1:15", "1:16", "1:17", "1:18"] as const
const PSA_VERSES = ["23:1", "23:2", "23:3", "23:4", "23:5", "23:6"] as const
const cellIdFor = (book: string, verse: string) => `cell-${book}-${verse.replace(":", "-")}`

function makeRows(book: string, verses: readonly string[]): CellRow[] {
  return verses.flatMap((verse) => {
    const id = cellIdFor(book, verse)
    const ref = `${book} ${verse}`
    const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: ref, anchorCellId: null, wordCount: 1 }
    // The verses the text fixture has are the import's own text; the others stand in.
    const source = Object.hasOwn(text.verses, ref) ? maculaHebrewImportText(text, ref) : `source ${ref}`
    return [
      { ...shared, side: "source", value: source, eventId: `${id}-source`, sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false },
      { ...shared, side: "target", value: `target ${ref}`, eventId: `${id}-target`, sourceEventId: `${id}-source`, lastEditor: "tester", lastEditAt: 2, validated: false },
    ] satisfies CellRow[]
  })
}

function makeProject(book: string): ProjectRecord {
  return {
    id: "proj-1",
    name: book === "RUT" ? "Rut" : "Mazmur",
    sourceLanguage: "hbo",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: `file-${book}`, name: book, type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
  }
}

function renderBook(book: "RUT" | "PSA") {
  const verses = book === "RUT" ? RUT_VERSES : PSA_VERSES
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: `file-${book}`, username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(book, verses), { full: true, maxServerSeq: 1 })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EditorActionsProvider value={{}}>
        <EditorTable
          project={makeProject(book)}
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
          sourceTextDirection="rtl"
          targetTextDirection="ltr"
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

const rut = (verse: string) => cellIdFor("RUT", verse)

/** What a sighted reader sees in a row's voice chip, separators included. */
function chipText(cellId: string): string {
  const chip = row(cellId).querySelector<HTMLElement>('[data-testid="voice-chip"]')
  return (chip?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** Bidi isolates are invisible; strip them to compare names. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

async function openContextTab(cellId: string): Promise<HTMLElement> {
  fireEvent.click(within(row(cellId)).getByRole("button", { name: "Open cell details" }))
  const tab = await waitFor(() => within(row(cellId)).getByRole("tab", { name: /Context/ }))
  fireEvent.click(tab)
  return within(row(cellId)).findByTestId("cell-context-tab")
}

function wordRow(tab: HTMLElement, wordId: string): HTMLElement {
  const el = tab.querySelector<HTMLElement>(`[data-word-id="${wordId}"]`)
  if (!el) throw new Error(`no word ${wordId}`)
  return el
}

/** The span that shows a word of the Context tab's list (its first child holds the word itself). */
const wordText = (tab: HTMLElement, wordId: string) =>
  wordRow(tab, wordId).querySelector<HTMLElement>("[lang]") ?? (() => { throw new Error(`no text for ${wordId}`) })()

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Voices on the Old Testament", () => {
  it("shows RUT 1:16–17 as Ruth speaking to Naomi, the rail opening in 1:16 and closing in 1:17", async () => {
    renderBook("RUT")
    await waitFor(() => expect(chipText(rut("1:16"))).not.toBe(""))
    // The narrator says "And Ruth said"; then Ruth speaks to Naomi until the end of 1:17.
    expect(chipText(rut("1:16"))).toBe("Narrator·Ruth→Naomi")
    expect(chipText(rut("1:17"))).toBe("Ruth→Naomi")
    const level1 = (verse: string) => row(rut(verse)).querySelector<HTMLElement>('[data-rail-level="1"]')
    expect(level1("1:16")?.dataset).toMatchObject({ railShape: "begin", railCapStart: "true" })
    expect(level1("1:17")?.dataset).toMatchObject({ railShape: "end", railCapEnd: "true" })
    // OT quote depth 2 is level 1 (no self-projection in the OT): one rail, never a second level.
    expect(row(rut("1:16")).querySelector('[data-rail-level="2"]')).toBeNull()
    expect(visible(within(row(rut("1:16"))).getByText(/^Speech by/).textContent)).toBe("Speech by Ruth begins")
    expect(visible(within(row(rut("1:17"))).getByText(/^Speech by/).textContent)).toBe("Speech by Ruth ends")
    // The narration after it has no rail.
    expect(row(rut("1:18")).querySelector('[data-testid="speech-rails"]')).toBeNull()
  })

  it("gives Psalm 23 to the psalmist alone: the narrator's voice in every verse, no rails", async () => {
    renderBook("PSA")
    await waitFor(() => expect(chipText(cellIdFor("PSA", "23:1"))).not.toBe(""))
    for (const verse of PSA_VERSES) {
      expect(chipText(cellIdFor("PSA", verse)), verse).toBe("Narrator")
      expect(row(cellIdFor("PSA", verse)).querySelector('[data-testid="speech-rails"]'), verse).toBeNull()
    }
  })
})

describe("the Context tab on a Hebrew verse", () => {
  it("lists RUT 1:16's morphemes right to left, as Hebrew, inside the left-to-right page", async () => {
    renderBook("RUT")
    const tab = await openContextTab(rut("1:16"))
    // Every morpheme of the verse, in order: prefixes and suffixes are rows of their own.
    const listed = [...tab.querySelectorAll<HTMLElement>("[data-word-id]")].map((li) => li.dataset.wordId)
    expect(listed).toEqual(text.verses["RUT 1:16"])
    const me = wordText(tab, ME_1_16)
    expect(me.getAttribute("lang")).toBe("hbo")
    expect(me.getAttribute("dir")).toBe("rtl")
    expect(me.textContent).toBe(text.words[ME_1_16].text)
    // The tab itself is not turned around: only the Hebrew reads right to left.
    expect(tab.closest('[dir="rtl"]')).toBeNull()
    // Its gloss, and who it refers to, in the interface's direction.
    expect(within(wordRow(tab, ME_1_16)).getByText("me")).toBeTruthy()
    const referent = within(wordRow(tab, ME_1_16)).getByTestId("context-referent")
    expect(referent.dataset.entity).toBe(RUTH)
    expect(referent.getAttribute("dir")).toBe("auto")
    expect(visible(referent.textContent)).toContain("Ruth")
  })

  it("marks the morphemes of RUT 1:16's doublet note, lists the note without a quote, and asks its question", async () => {
    renderBook("RUT")
    const tab = await openContextTab(rut("1:16"))
    await within(tab).findByTestId("context-notes")
    const doublet = rutNotes().notes.find((note) => note.id === DOUBLET_NOTE_1_16)
    const noted = [...tab.querySelectorAll<HTMLElement>("[data-word-id]")]
      .filter((li) => (li.dataset.notes ?? "").split(" ").includes(DOUBLET_NOTE_1_16))
      .map((li) => li.dataset.wordId)
    expect(noted).toEqual(doublet?.words)
    // "and where you live" quotes nothing: listed for the verse, nothing highlighted.
    expect(within(tab).getByTestId("context-other-notes").querySelector(`[data-note-id="${QUOTELESS_NOTE_1_16}"]`)).not.toBeNull()
    const question = rutNotes().questions.find((candidate) => candidate.id === QUESTION_1_16)
    const item = within(tab).getByTestId("context-questions").querySelector(`[data-question-id="${QUESTION_1_16}"]`)
    expect(item?.querySelector("summary")?.textContent).toBe(question?.q)
  })

  it("shows RUT 1:1's implied article by its lemma, and marks it with the note on בָּאָרֶץ", async () => {
    renderBook("RUT")
    const tab = await openContextTab(rut("1:1"))
    await within(tab).findByTestId("context-notes")
    const article = wordText(tab, IMPLIED_ARTICLE_1_1)
    expect(article.dataset.implied).toBe("true")
    expect(article.textContent?.startsWith(`(${text.words[IMPLIED_ARTICLE_1_1].lemma})`)).toBe(true)
    expect(article.getAttribute("lang")).toBe("hbo")
    expect(wordRow(tab, IMPLIED_ARTICLE_1_1).dataset.notes?.split(" ")).toContain(LAND_NOTE_1_1)
  })

  it("shows the Ketiv a RUT 1:8 note quotes right to left, as Hebrew, since no word carries it", async () => {
    renderBook("RUT")
    const tab = await openContextTab(rut("1:8"))
    const card = await waitFor(() => {
      const found = tab.querySelector<HTMLElement>(`[data-note-id="${KETIV_NOTE_1_8}"]`)
      if (!found) throw new Error("no Ketiv note yet")
      return found
    })
    expect(card.dataset.anchor).toBe("unanchored")
    const quote = within(card).getByTestId("note-quote")
    expect(quote.getAttribute("lang")).toBe("hbo")
    expect(quote.getAttribute("dir")).toBe("rtl")
  })
})

describe("mentions on a Hebrew source", () => {
  it("puts each of RUT 1:16's mentions on its own morpheme, the suffix 'me' on Ruth", async () => {
    renderBook("RUT")
    const people = rutPeople()
    // What the pack says, morpheme by morpheme (an implied article has no letters to mark).
    const expected = text.verses["RUT 1:16"]
      .filter((id) => Object.hasOwn(people.mentions, id) && text.words[id].text !== "")
      .map((id) => [text.words[id].text, people.mentions[id].entity])
    expect(expected).toContainEqual([text.words[ME_1_16].text, RUTH])
    const shown = await waitFor(() => {
      const tokens = [...row(rut("1:16")).querySelectorAll<HTMLElement>('[data-testid="mention"]')]
      if (tokens.length === 0) throw new Error("no mentions yet")
      return tokens.map((token) => [token.textContent, token.dataset.mentionEntity])
    })
    expect(shown).toEqual(expected)
  })
})
