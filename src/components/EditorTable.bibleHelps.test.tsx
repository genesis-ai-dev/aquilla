/**
 * AQU-1695 — Bible Knowledge Pack 1.1 in the editor: the Context tab's
 * Translation Notes, Questions, key terms and "via" chains; the Who's Who
 * popover's description and family; and pack slice 3's optional fields.
 *
 * Through the real pack client over a stubbed fetch serving real pack 1.1.0
 * data for John (src/lib/bible-data/__fixtures__/jhn4-pack11.ts). What it
 * protects, in the translator's terms:
 *   • a note is highlighted on exactly the Greek words it discusses, and only
 *     when the pack found its quote in one place; every other note is listed
 *     for the verse without pointing at any word;
 *   • a question's answer stays hidden until asked for; a range says so;
 *   • key terms sit on the words that carry them, only while Key terms is on;
 *   • "αὐτόν → Jesus" says which word the chain went through;
 *   • the 1.3 MB notes layer is fetched only when Translation helps is on AND
 *     a Context tab opens, once per book;
 *   • slice 3's deity form and disputed speech are used when they appear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { AUTON_4_10, JESUS, JHN4_STRUCTURE_JSON, JHN4_VOICES_JSON, maculaImportText } from "@/lib/bible-data/__fixtures__/jhn4"
import {
  AMBIGUOUS_NOTE_4_51,
  ISRAEL,
  JHN4_11_NOTES_JSON,
  JHN4_11_PEOPLE_JSON,
  JHN4_11_TERMS_JSON,
  JHN4_11_TEXT_JSON,
  JOSEPH_10,
  LEGON_4_10,
  LEVI_3,
  PACK11_VERSES,
  QUESTION_4_9,
  QUOTELESS_NOTE_4_11,
  RANGE_QUESTION_4_14,
  RQUESTION_NOTE_4_9,
  SPLIT_NOTE_4_9,
  THEOU_4_10,
  UNANCHORED_NOTE_5_12,
  jhn4Notes11,
  jhn4People11,
  jhn4Terms11,
  jhn4Text11,
} from "@/lib/bible-data/__fixtures__/jhn4-pack11"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { BkpPeopleLayer, BkpVoicesLayer } from "@/lib/bible-data/pack-types"
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

// ── Pack 1.1.0, served by a stubbed fetch ───────────────────────────────────

const MANIFEST = {
  pack: "bkp",
  version: "1.1.0",
  builtAt: "2026-10-06T07:29:11.834Z",
  versification: "org",
  sources: [],
  layers: {},
  books: { JHN: { layers: ["text", "structure", "voices", "people", "notes", "terms"], bytes: {} } },
}

// JHN 4's structure layer is the same in 1.0.0 and 1.1.0. The voices file is
// 1.0.0's: the slice 3 test below only adds a field to one of its speeches.
const BASE_FILES: Readonly<Record<string, string>> = {
  "/people/JHN.json": JHN4_11_PEOPLE_JSON,
  "/text/JHN.json": JHN4_11_TEXT_JSON,
  "/structure/JHN.json": JHN4_STRUCTURE_JSON,
  "/voices/JHN.json": JHN4_VOICES_JSON,
  "/notes/JHN.json": JHN4_11_NOTES_JSON,
  "/terms/JHN.json": JHN4_11_TERMS_JSON,
}
let files: Record<string, string> = { ...BASE_FILES }

const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(files).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})
const fetchesOf = (layer: string) =>
  fetchMock.mock.calls.filter(([input]) => new URL(input).pathname === `/bkp/v1/${layer}/JHN.json`).length

// ── A John file, its source the pack's own Greek words ──────────────────────

const FILE_ID = "file-jhn"
const text = jhn4Text11()
const cellIdFor = (verse: string) => `cell-${verse.replace(":", "-")}`

function makeRows(): CellRow[] {
  return PACK11_VERSES.flatMap((verse) => {
    const id = cellIdFor(verse)
    const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: `JHN ${verse}`, anchorCellId: null, wordCount: 1 }
    return [
      {
        ...shared,
        side: "source",
        value: maculaImportText(text, `JHN ${verse}`),
        eventId: `${id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
      },
      {
        ...shared,
        side: "target",
        value: `target ${verse}`,
        eventId: `${id}-target`,
        sourceEventId: `${id}-source`,
        lastEditor: "tester",
        lastEditAt: 2,
        validated: false,
      },
    ] satisfies CellRow[]
  })
}

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Injil Yohanes",
    sourceLanguage: "grc",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    ...overrides,
  }
}

function renderTable(project: ProjectRecord) {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: FILE_ID, username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(), { full: true, maxServerSeq: 1 })
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

function mentionOf(cellId: string, entity: string): HTMLElement {
  const found = [...row(cellId).querySelectorAll<HTMLElement>('[data-testid="mention"]')].find(
    (el) => el.dataset.mentionEntity === entity,
  )
  if (!found) throw new Error(`no mention of ${entity} in ${cellId}`)
  return found
}

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

function noteCard(tab: HTMLElement, noteId: string): HTMLElement {
  const el = tab.querySelector<HTMLElement>(`[data-note-id="${noteId}"]`)
  if (!el) throw new Error(`no note ${noteId}`)
  return el
}

/** The words the tab marks for a note, in the word list's order. */
function wordsNotedBy(tab: HTMLElement, noteId: string): string[] {
  return [...tab.querySelectorAll<HTMLElement>("[data-word-id]")]
    .filter((li) => (li.dataset.notes ?? "").split(" ").includes(noteId))
    .map((li) => li.dataset.wordId ?? "")
}

const noteById = (id: string) => {
  const note = jhn4Notes11().notes.find((candidate) => candidate.id === id)
  if (!note) throw new Error(`no note ${id}`)
  return note
}

/** Bidi isolates are invisible; strip them to compare text. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  files = { ...BASE_FILES }
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Translation Notes in the Context tab", () => {
  it("highlights exactly the Greek words of JHN 4:9's anchored notes, each marked with its note's number", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:9"))
    await within(tab).findByTestId("context-notes")

    expect(wordsNotedBy(tab, RQUESTION_NOTE_4_9)).toEqual(noteById(RQUESTION_NOTE_4_9).words)
    // "οὐ & συνχρῶνται": its two words, and not Ἰουδαῖοι between them.
    expect(wordsNotedBy(tab, SPLIT_NOTE_4_9)).toEqual(["n43004009019", "n43004009021"])
    // Nothing else is highlighted: the marked words are the anchored notes' words.
    const highlighted = [...tab.querySelectorAll<HTMLElement>('[data-noted="true"]')].map(
      (el) => el.closest<HTMLElement>("[data-word-id]")?.dataset.wordId,
    )
    const anchoredWords = ["tn:211088", RQUESTION_NOTE_4_9, SPLIT_NOTE_4_9].flatMap((id) => noteById(id).words ?? [])
    expect(new Set(highlighted)).toEqual(new Set(anchoredWords))

    // The rhetorical question is this cell's second note: its card and its words say "2".
    const card = noteCard(tab, RQUESTION_NOTE_4_9)
    expect(within(card).getByTestId("note-category").textContent).toBe("Rhetorical question")
    expect(card.textContent).toContain("Note 2")
    for (const wordId of noteById(RQUESTION_NOTE_4_9).words ?? []) {
      expect(wordRow(tab, wordId).querySelector("sup")?.textContent?.split(","), wordId).toContain("2")
    }
    expect(visible(wordRow(tab, "n43004009019").textContent)).toContain("Discussed in note 3")
  })

  it.each([
    ["4:51", AMBIGUOUS_NOTE_4_51, "the pack found its quote in more than one place"],
    ["5:12", UNANCHORED_NOTE_5_12, "SBLGNT does not have the UGNT word order it quotes"],
    ["4:11", QUOTELESS_NOTE_4_11, "it quotes no Greek at all"],
  ])("lists JHN %s's note %s under 'Notes on this verse' without highlighting a word: %s", async (verse, noteId) => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor(verse))
    const others = await within(tab).findByTestId("context-other-notes")
    expect(within(others).getByRole("heading").textContent).toBe("Notes on this verse")
    expect(others.querySelector(`[data-note-id="${noteId}"]`)).not.toBeNull()
    expect(wordsNotedBy(tab, noteId)).toEqual([])
    const note = noteById(noteId)
    // Its Greek shows on the card instead, when it has some; else the general chip.
    if (note.quote) expect(within(noteCard(tab, noteId)).getByText(note.quote)).toBeTruthy()
    else expect(within(noteCard(tab, noteId)).getByTestId("note-category").textContent).toBe("Translation note")
  })

  it("leaves the ambiguous note's word in JHN 4:51 unmarked, though the pack picked a place for it", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:51"))
    await within(tab).findByTestId("context-notes")
    expect(noteById(AMBIGUOUS_NOTE_4_51).words).toEqual(["n43004051003"])
    expect(wordRow(tab, "n43004051003").querySelector('[data-noted="true"]')).toBeNull()
  })
})

describe("Translation Questions in the Context tab", () => {
  it("asks JHN 4:9's question with its answer collapsed", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:9"))
    const questions = await within(tab).findByTestId("context-questions")
    const item = questions.querySelector<HTMLElement>(`[data-question-id="${QUESTION_4_9}"]`)
    if (!item) throw new Error("no JHN 4:9 question")
    const question = jhn4Notes11().questions.find((candidate) => candidate.id === QUESTION_4_9)
    const details = item.querySelector("details")
    const summary = item.querySelector("summary")
    expect(summary?.textContent).toBe(question?.q)
    expect(details?.open).toBe(false)
    expect(details?.contains(within(item).getByTestId("context-answer"))).toBe(true)
    expect(within(item).getByTestId("context-answer").textContent).toBe(question?.a)
  })

  it("says which verses a question on JHN 4:14–15 covers, and nothing for a one-verse question", async () => {
    renderTable(makeProject())
    const tab14 = await openContextTab(cellIdFor("4:14"))
    const range = (await within(tab14).findByTestId("context-questions")).querySelector(
      `[data-question-id="${RANGE_QUESTION_4_14}"] summary`,
    )
    expect(visible(range?.textContent)).toContain("Verses JHN 4:14–15")

    const tab9 = await openContextTab(cellIdFor("4:9"))
    const single = (await within(tab9).findByTestId("context-questions")).querySelector(
      `[data-question-id="${QUESTION_4_9}"] summary`,
    )
    expect(single?.textContent).not.toContain("Verses")
  })
})

describe("key terms in the Context tab", () => {
  it("puts a chip on each word that carries a key term, and names its source in the popover", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:9"))
    await within(tab).findAllByTestId("term-chip")
    const terms = jhn4Terms11()
    for (const wordId of text.verses["JHN 4:9"]) {
      const chips = [...wordRow(tab, wordId).querySelectorAll<HTMLElement>('[data-testid="term-chip"]')]
      expect(chips.map((chip) => chip.dataset.term), wordId).toEqual(terms.words[wordId] ?? [])
    }
    const samaria = wordRow(tab, "n43004009007").querySelector<HTMLElement>('[data-testid="term-chip"]')
    if (!samaria) throw new Error("no Samaria chip")
    expect(samaria.textContent).toBe("Samaria")
    expect(visible(samaria.getAttribute("aria-label"))).toBe("Key term: Samaria")

    act(() => samaria.focus())
    const details = await screen.findByTestId("term-details")
    expect(within(details).getByRole("heading").textContent).toBe("Samaria")
    expect(details.textContent).toContain("From unfoldingWord Translation Words")
  })

  it("shows no chips, and fetches no terms, while Key terms is off", async () => {
    renderTable(makeProject({ bibleEnrichments: { terms: false } }))
    const tab = await openContextTab(cellIdFor("4:9"))
    await within(tab).findByTestId("context-notes")
    expect(within(tab).queryAllByTestId("term-chip")).toEqual([])
    expect(fetchesOf("terms")).toBe(0)
  })
})

describe("the chain behind a pronoun", () => {
  it("says αὐτόν in JHN 4:10 reaches Jesus via λέγων, with its gloss", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:10"))
    const referent = within(wordRow(tab, AUTON_4_10)).getByTestId("context-referent")
    expect(referent.dataset.entity).toBe(JESUS)
    expect(jhn4People11().mentions[AUTON_4_10].via).toEqual([LEGON_4_10])
    expect(visible(referent.textContent)).toContain("via λέγων (saying)")
    // λέγων's own subject is one link away: no chain to show.
    expect(visible(within(wordRow(tab, LEGON_4_10)).getByTestId("context-referent").textContent)).not.toContain("via")
  })
})

describe("when the notes layer loads", () => {
  it("fetches notes only once a Context tab first opens, and once for the book", async () => {
    renderTable(makeProject())
    // The people and words are in: the rows show their mentions.
    await waitFor(() => expect(row(cellIdFor("4:10")).querySelector('[data-testid="mention"]')).not.toBeNull())
    await settle()
    expect(fetchesOf("notes")).toBe(0)
    expect(fetchesOf("terms")).toBe(0)

    const first = await openContextTab(cellIdFor("4:9"))
    await within(first).findByTestId("context-notes")
    expect(fetchesOf("notes")).toBe(1)
    expect(fetchesOf("terms")).toBe(1)

    const second = await openContextTab(cellIdFor("4:10"))
    await within(second).findByTestId("context-notes")
    expect(fetchesOf("notes")).toBe(1)
  })

  it("shows no notes or questions, and never fetches them, while Translation helps is off", async () => {
    renderTable(makeProject({ bibleEnrichments: { helps: false } }))
    const tab = await openContextTab(cellIdFor("4:9"))
    // Key terms is still on: once its chips are in, the tab has loaded what it will.
    await within(tab).findAllByTestId("term-chip")
    await settle()
    expect(within(tab).queryByTestId("context-notes")).toBeNull()
    expect(within(tab).queryByTestId("context-questions")).toBeNull()
    expect(within(tab).queryByTestId("context-helps-loading")).toBeNull()
    expect(tab.querySelector("[data-notes]")).toBeNull()
    expect(fetchesOf("notes")).toBe(0)
  })
})

describe("Who's Who popover, pack 1.1", () => {
  it("describes Jacob, and takes his son Joseph's name to Joseph's first mention; Levi, never mentioned, is text", async () => {
    renderTable(makeProject())
    await waitFor(() => mentionOf(cellIdFor("4:6"), ISRAEL))
    act(() => mentionOf(cellIdFor("4:6"), ISRAEL).focus())
    const details = await screen.findByTestId("mention-details")
    const description = within(details).getByTestId("entity-description")
    expect(description.textContent).toBe(jhn4People11().entities[ISRAEL].descriptions?.eng)
    expect(description.getAttribute("lang")).toBe("en")

    const kin = within(details).getByTestId("entity-kin")
    expect(within(kin).getByText("Children")).toBeTruthy()
    expect(kin.querySelector(`[data-kin="${LEVI_3}"] button`)).toBeNull()
    expect(visible(kin.querySelector(`[data-kin="${LEVI_3}"]`)?.textContent)).toBe("Levi")
    fireEvent.click(
      within(kin).getByRole("button", {
        name: (name) => visible(name) === "Go to the first mention of Joseph, JHN 4:5",
      }),
    )
    await waitFor(() => expect(document.activeElement).toBe(mentionOf(cellIdFor("4:5"), JOSEPH_10)))
  })
})

// Pack slice 3 is not built yet; these files add its fields to real records.
describe("pack slice 3, accepted before it ships", () => {
  it("names τοῦ θεοῦ in JHN 4:10 by its form, 'God', where the entity's label is 'LORD'", async () => {
    const people = JSON.parse(JHN4_11_PEOPLE_JSON) as BkpPeopleLayer
    people.mentions[THEOU_4_10] = { ...people.mentions[THEOU_4_10], form: { eng: "God" } }
    files["/people/JHN.json"] = JSON.stringify(people)
    renderTable(makeProject())
    await waitFor(() => mentionOf(cellIdFor("4:10"), "deity:Lord"))
    const word = mentionOf(cellIdFor("4:10"), "deity:Lord")
    expect(visible(word.getAttribute("aria-label"))).toBe("θεοῦ: Named, God")
    act(() => word.focus())
    const details = await screen.findByTestId("mention-details")
    expect(visible(within(details).getByRole("heading").textContent)).toBe("God")

    const tab = await openContextTab(cellIdFor("4:10"))
    const referent = within(wordRow(tab, THEOU_4_10)).getByTestId("context-referent")
    expect(visible(referent.textContent)).toContain("God")
    expect(visible(referent.textContent)).not.toContain("LORD")
  })

  it("keeps the entity's own label for a deity mention without a form", async () => {
    renderTable(makeProject())
    const tab = await openContextTab(cellIdFor("4:10"))
    expect(visible(within(wordRow(tab, THEOU_4_10)).getByTestId("context-referent").textContent)).toContain("LORD")
  })

  it("badges a disputed speech in the voice popover, and no other", async () => {
    const voices = JSON.parse(JHN4_VOICES_JSON) as BkpVoicesLayer
    const answer = voices.speeches.find((speech) => speech.id === "sp:n43004010006-n43004010030")
    if (!answer) throw new Error("no JHN 4:10 speech")
    answer.disputed = { reason: "Where this answer ends is disputed (synthetic).", source: "test" }
    files["/voices/JHN.json"] = JSON.stringify(voices)
    renderTable(makeProject())

    const chip10 = await waitFor(() => {
      const chip = row(cellIdFor("4:10")).querySelector<HTMLElement>('[data-testid="voice-chip"]')
      if (!chip) throw new Error("no chip yet")
      return chip
    })
    act(() => chip10.focus())
    const details = await screen.findByTestId("voice-details")
    expect(within(details).getByTestId("speech-disputed").textContent).toBe("Boundary disputed")
    expect(details.textContent).toContain("Where this answer ends is disputed (synthetic).")
    act(() => chip10.blur())
    await waitFor(() => expect(screen.queryByTestId("voice-details")).toBeNull())

    const chip9 = row(cellIdFor("4:9")).querySelector<HTMLElement>('[data-testid="voice-chip"]')
    if (!chip9) throw new Error("no JHN 4:9 chip")
    act(() => chip9.focus())
    expect(within(await screen.findByTestId("voice-details")).queryByTestId("speech-disputed")).toBeNull()
  })
})
