/**
 * AQU-1689 — Who's Who in the editor: follow one participant through the text.
 *
 * The story under test is aquilla-specs 05-user-stories/follow-a-participant-thread.md,
 * end to end through the real pack client: a stubbed fetch serves real Bible
 * Knowledge Pack data (JHN 4, MRK 1; src/lib/bible-data/__fixtures__), and
 * the table must
 *   • tint every mention of the hovered or focused participant in the rows on
 *     screen, and only that participant's (a group is never one of its
 *     members), when the source cell's words ARE the pack's words;
 *   • show no word tints at all on a gateway-language source, while the
 *     Context tab still explains the verse;
 *   • answer "who is αὐτόν?" in JHN 4:10 with Jesus, two links away;
 *   • move between mentions from the popover, with keyboard focus landing on
 *     the participant's word in the next verse;
 *   • filter to the cells that mention a participant, with the same bar and
 *     way back as "Show every line by …";
 *   • show none of it when the project turns the enrichment off, and none of
 *     it, with nothing fetched, unless this device has the Bible data
 *     experiment on and a Bible is open (AQU-1685).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ComponentProps, ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { requestBibleFilter } from "./bible-data/bible-data-bus"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import {
  AUTON_4_10,
  JESUS,
  JHN4_PEOPLE_JSON,
  JHN4_STRUCTURE_JSON,
  JHN4_TEXT_JSON,
  SAMARITAN_WOMAN,
  jhn4People,
  jhn4Text,
  maculaImportText,
} from "@/lib/bible-data/__fixtures__/jhn4"
import {
  ELTHON_1_29,
  JESUS_AND_FOUR,
  MRK1_PEOPLE_JSON,
  MRK1_STRUCTURE_JSON,
  MRK1_TEXT_JSON,
} from "@/lib/bible-data/__fixtures__/mrk1"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import {
  resetBibleDataViewPrefsCacheForTests,
  setBibleDataViewPrefs,
} from "@/lib/store/bible-data-view-prefs"
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

const MANIFEST = {
  pack: "bkp",
  version: "1.0.0",
  builtAt: "2026-10-06T03:39:26.174Z",
  versification: "org",
  sources: [],
  layers: {},
  books: {
    JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} },
    MRK: { layers: ["text", "structure", "voices", "people"], bytes: {} },
  },
}

const FILES: Readonly<Record<string, string>> = {
  "/people/JHN.json": JHN4_PEOPLE_JSON,
  "/text/JHN.json": JHN4_TEXT_JSON,
  "/structure/JHN.json": JHN4_STRUCTURE_JSON,
  "/people/MRK.json": MRK1_PEOPLE_JSON,
  "/text/MRK.json": MRK1_TEXT_JSON,
  "/structure/MRK.json": MRK1_STRUCTURE_JSON,
}

const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})
const layerFetches = () =>
  fetchMock.mock.calls.map(([input]) => new URL(input).pathname).filter((path) => !path.endsWith("manifest.json"))

// ── A JHN 4 file ────────────────────────────────────────────────────────────

const VERSES = ["4:6", "4:7", "4:8", "4:9", "4:10"] as const
const cellIdFor = (verse: string) => `cell-${verse.replace(":", "-")}`
const FILE_ID = "file-jhn"
const text = jhn4Text()

/** The cell as a Macula import stores it: the pack's words, space-joined. */
const greekSource = (verse: string) => maculaImportText(text, `JHN ${verse}`)
/** A gateway-language source (an English Bible): never the pack's words. */
const englishSource = (verse: string) => `English text of John ${verse}.`

function makeRows(source: (verse: string) => string, book = "JHN", verses: readonly string[] = VERSES): CellRow[] {
  return verses.flatMap((verse) => {
    const id = cellIdFor(verse)
    const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: `${book} ${verse}`, anchorCellId: null, wordCount: 1 }
    return [
      {
        ...shared,
        side: "source",
        value: source(verse),
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
    // A scripture file: Bible data is on by its derived default.
    files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    // AQU-1685: this device switched on the Bible data experiment.
    experimentalFlags: { bibleData: true },
    ...overrides,
  }
}

/** `bibleOpen` is what ProjectWorkspace passes: true while the editor shows a scripture file. */
function renderTable(
  project: ProjectRecord,
  source: (verse: string) => string = greekSource,
  rows: CellRow[] = makeRows(source),
  bibleOpen = true,
  extra: Partial<ComponentProps<typeof EditorTable>> = {},
) {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: FILE_ID, username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
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
          bibleOpen={bibleOpen}
          {...extra}
        />
      </EditorActionsProvider>
    </QueryClientProvider>
  )
  const view = render(ui(project))
  return { rerender: (next: ProjectRecord) => view.rerender(ui(next)), unmount: () => view.unmount() }
}

function row(cellId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-id="${cellId}"][data-index]`)
  if (!el) throw new Error(`no row ${cellId}`)
  return el
}

function mentionsIn(cellId: string): HTMLElement[] {
  return [...row(cellId).querySelectorAll<HTMLElement>('[data-testid="mention"]')]
}

function allMentions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="mention"]')]
}

function litMentions(): HTMLElement[] {
  return allMentions().filter((el) => el.dataset.mentionLit === "true")
}

/** The mention token for one Macula word, found by its text in a row. */
function mentionWord(cellId: string, word: string): HTMLElement {
  const found = mentionsIn(cellId).find((el) => el.textContent === word)
  if (!found) throw new Error(`no mention "${word}" in ${cellId}`)
  return found
}

/** How many words in these verses the pack says refer to `entity`. */
function packMentionCount(entity: string, verses: readonly string[]): number {
  const mentions = jhn4People().mentions
  return verses.reduce(
    (sum, verse) => sum + text.verses[`JHN ${verse}`].filter((id) => mentions[id]?.entity === entity).length,
    0,
  )
}

/** Bidi isolates are invisible; strip them to compare text. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

async function mentionsLoaded() {
  await waitFor(() => expect(mentionsIn(cellIdFor("4:10")).length).toBeGreaterThan(0))
}

async function openContextTab(cellId: string): Promise<HTMLElement> {
  fireEvent.click(within(row(cellId)).getByRole("button", { name: "Open cell details" }))
  const tab = await waitFor(() => within(row(cellId)).getByRole("tab", { name: /Context/ }))
  fireEvent.click(tab)
  return within(row(cellId)).findByTestId("cell-context-tab")
}

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

describe("word tints on a Greek source", () => {
  it("marks the words that refer to someone, and only those, in every verse on screen", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    for (const verse of VERSES) {
      const ids = text.verses[`JHN ${verse}`].filter((id) => jhn4People().mentions[id])
      expect(mentionsIn(cellIdFor(verse)), verse).toHaveLength(ids.length)
    }
    // At rest nothing is lit: the dotted underline is the only mark.
    expect(litMentions()).toEqual([])
  })

  it("lights every mention of Jesus in the rows on screen when αὐτόν in 4:10 is hovered, and nobody else's", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    const auton = mentionWord(cellIdFor("4:10"), "αὐτὸν")
    expect(auton.dataset.mentionEntity).toBe(JESUS)

    fireEvent.pointerEnter(auton)
    const lit = litMentions()
    expect(lit.length).toBe(packMentionCount(JESUS, VERSES))
    expect(new Set(lit.map((el) => el.dataset.mentionEntity))).toEqual(new Set([JESUS]))
    // Every verse on screen takes part, from 4:6 to 4:10.
    for (const verse of VERSES) {
      expect(mentionsIn(cellIdFor(verse)).some((el) => el.dataset.mentionLit === "true"), verse).toBe(true)
    }

    fireEvent.pointerLeave(auton)
    expect(litMentions()).toEqual([])
  })

  it("lights the same thread on keyboard focus, and opens the popover with who it is", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    const auton = mentionWord(cellIdFor("4:10"), "αὐτὸν")
    expect(visible(auton.getAttribute("aria-label"))).toBe("αὐτὸν: Pronoun, Jesus")

    act(() => auton.focus())
    expect(litMentions().length).toBe(packMentionCount(JESUS, VERSES))
    const details = await screen.findByTestId("mention-details")
    expect(visible(within(details).getByRole("heading").textContent)).toBe("Jesus")
    expect(visible(details.textContent)).toContain("First mention in this passage: JHN 4:1")
    // αὐτόν reaches Jesus through λέγων: two links, so the data is less sure.
    expect(within(details).getByTestId("mention-hops").textContent).toBe("Reached through 2 links")
    expect(visible(details.textContent)).toContain("70% sure, from Macula")
  })

  it("keeps the Samaritan woman's thread apart from Jesus's", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    fireEvent.pointerEnter(mentionWord(cellIdFor("4:7"), "γυνὴ"))
    const lit = litMentions()
    expect(lit.length).toBe(packMentionCount(SAMARITAN_WOMAN, VERSES))
    expect(new Set(lit.map((el) => el.dataset.mentionEntity))).toEqual(new Set([SAMARITAN_WOMAN]))
  })

  it("moves to the next mention from the popover, with focus on Jesus's first word there", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    // αὐτοῦ in 4:8 is Jesus; the next verse that mentions him is 4:9.
    act(() => mentionWord(cellIdFor("4:8"), "αὐτοῦ").focus())
    const details = await screen.findByTestId("mention-details")
    fireEvent.click(within(details).getByRole("button", { name: /^Next mention of/ }))

    const firstJesusIn49 = mentionsIn(cellIdFor("4:9")).find((el) => el.dataset.mentionEntity === JESUS)
    await waitFor(() => expect(document.activeElement).toBe(firstJesusIn49))
    expect(firstJesusIn49?.textContent).toBe("αὐτῷ")
  })

  it("shows a hint before a verb whose implied subject is named, and more or none as the person chooses", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    const hints = () =>
      [...row(cellIdFor("4:10")).querySelectorAll('[data-testid="implied-subject-hint"]')].map((el) =>
        visible(el.textContent),
      )
    // εἶπεν and ἔδωκεν ("he said", "he would have given") are Jesus's.
    expect(hints()).toContain("[he = Jesus]")
    // ᾔδεις ("you had known") is the unnamed woman: not a name, so hidden.
    expect(hints()).not.toContain("[you = Samaritan woman]")
    // λέγων and πεῖν (a participle, an infinitive) carry no person of their
    // own: at rest a hint there would only repeat the text, so there is none.
    expect(hints().every((hint) => hint.includes(" = "))).toBe(true)

    act(() => setBibleDataViewPrefs({ impliedSubjectHints: "all" }))
    expect(hints()).toContain("[you = Samaritan woman]")

    act(() => setBibleDataViewPrefs({ impliedSubjectHints: "off" }))
    expect(hints()).toEqual([])
  })

  it("keeps every mention tinted in its participant's thread color when the person picks Always", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    act(() => setBibleDataViewPrefs({ whosWhoHighlights: "always" }))
    expect(allMentions().every((el) => el.dataset.mentionTinted === "true")).toBe(true)
    // Jesus and the woman lead JHN 4:1–26's cast, so they hold the first two colors.
    const slotOf = (entity: string) => allMentions().find((el) => el.dataset.mentionEntity === entity)?.dataset.threadSlot
    expect(new Set([slotOf(JESUS), slotOf(SAMARITAN_WOMAN)])).toEqual(new Set(["1", "2"]))
  })

  it("drops the marks, and keeps the text, when the person turns highlights off", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    act(() => setBibleDataViewPrefs({ whosWhoHighlights: "off" }))
    expect(allMentions()).toEqual([])
    expect(row(cellIdFor("4:10")).textContent).toContain("αὐτὸν")
  })
})

// AQU-1693: "Add to terminology" in the mention popover. In a Greek source the
// pack has no label to use as the headword, so the word that names him gives
// it; a pronoun is not his name, so it falls back to his English name.
describe("add to terminology from the mention popover", () => {
  async function addFrom(word: string, verse = "4:10") {
    const add = vi.fn()
    const view = renderTable(makeProject(), greekSource, makeRows(greekSource), true, { onAddConceptFromSelection: add })
    await mentionsLoaded()
    act(() => mentionWord(cellIdFor(verse), word).focus())
    const details = await screen.findByTestId("mention-details")
    fireEvent.click(within(details).getByRole("button", { name: /Add .*Jesus.* to terminology/ }))
    view.unmount()
    return add.mock.calls[0]?.[0]
  }

  it("takes the headword from the word that names him", async () => {
    expect(await addFrom("Ἰησοῦς")).toEqual({ sourceTerm: "Ἰησοῦς", externalIds: { acai: JESUS } })
  })

  it("does not take a pronoun's lemma for his name", async () => {
    expect(await addFrom("αὐτὸν")).toEqual({ sourceTerm: "Jesus", externalIds: { acai: JESUS } })
  })
})

describe("a gateway-language source", () => {
  it("shows no word tints, and the Context tab still explains the verse", async () => {
    renderTable(makeProject({ sourceLanguage: "en" }), englishSource)
    const tab = await openContextTab(cellIdFor("4:10"))
    expect(allMentions()).toEqual([])
    expect(row(cellIdFor("4:10")).textContent).toContain("English text of John 4:10.")
    expect(within(tab).getByText("αὐτὸν")).toBeTruthy()
  })
})

describe("the Context tab", () => {
  it("answers who αὐτόν in JHN 4:10 is: Jesus, two links away", async () => {
    renderTable(makeProject(), englishSource)
    const tab = await openContextTab(cellIdFor("4:10"))
    const autonRow = tab.querySelector<HTMLElement>(`[data-word-id="${AUTON_4_10}"]`)
    if (!autonRow) throw new Error("no αὐτόν row")
    expect(autonRow.textContent).toContain("Him")
    const referent = within(autonRow).getByTestId("context-referent")
    expect(referent.dataset.entity).toBe(JESUS)
    expect(visible(referent.textContent)).toContain("Jesus")
    expect(visible(referent.textContent)).toContain("Reached through 2 links")
    expect(visible(within(referent).getByText(/refers to/).textContent)).toBe("αὐτὸν refers to Jesus")
  })

  it("shows an implied subject as [he = Jesus], and a word that refers to nobody with its gloss alone", async () => {
    renderTable(makeProject(), englishSource)
    const tab = await openContextTab(cellIdFor("4:10"))
    const eipen = tab.querySelector<HTMLElement>('[data-word-id="n43004010004"]')
    expect(visible(eipen?.textContent)).toContain("[he = Jesus]")
    const kai = tab.querySelector<HTMLElement>('[data-word-id="n43004010003"]')
    expect(kai?.querySelector('[data-testid="context-referent"]')).toBeNull()
    // The Context tab lists every implied subject, a participle's too.
    const legon = tab.querySelector<HTMLElement>('[data-word-id="n43004010016"]')
    expect(visible(legon?.textContent)).toContain("[Jesus]")
  })
})

// MRK 1:29, "they came": the subject of ἦλθον is Jesus with Simon, Andrew,
// James and John. The Context tab names the group by its five members, as a
// group, and never as Jesus alone.
describe("a group", () => {
  it("shows ἦλθον's implied subject in MRK 1:29 as the five, never one of them", async () => {
    renderTable(makeProject(), englishSource, makeRows(englishSource, "MRK", ["1:29", "1:30", "1:31"]))
    const tab = await openContextTab(cellIdFor("1:29"))
    const elthon = tab.querySelector<HTMLElement>(`[data-word-id="${ELTHON_1_29}"]`)
    const referent = elthon ? within(elthon).getByTestId("context-referent") : null
    expect(referent?.dataset.entity).toBe(JESUS_AND_FOUR)
    expect(visible(referent?.textContent)).toContain(
      "[they = Andrew, James, Jesus, John (Son of Zebedee), and Peter]",
    )
  })
})

describe("cells that mention a participant", () => {
  it("filters the rows from the popover, with the shared bar and the way back", async () => {
    renderTable(makeProject())
    await mentionsLoaded()
    // ἀγοράσωσιν in 4:8 is the disciples, who appear in no other verse here.
    const disciples = mentionsIn(cellIdFor("4:8")).find((el) => el.textContent === "μαθηταὶ")
    if (!disciples) throw new Error("no μαθηταί")
    act(() => disciples.focus())
    const details = await screen.findByTestId("mention-details")
    fireEvent.click(within(details).getByRole("button", { name: /^Show cells that mention/ }))

    const banner = await screen.findByTestId("voice-filter-banner")
    expect(banner.dataset.filterKind).toBe("mentions")
    expect(visible(banner.textContent)).toContain("Showing 1 cell that mentions disciples")
    expect(document.querySelector(`[data-cell-id="${cellIdFor("4:7")}"][data-index]`)).toBeNull()
    expect(row(cellIdFor("4:8"))).toBeTruthy()

    fireEvent.click(within(banner).getByRole("button", { name: "Show all lines" }))
    expect(screen.queryByTestId("voice-filter-banner")).toBeNull()
    expect(row(cellIdFor("4:7"))).toBeTruthy()
  })

  it("takes the filter from the Who's Who panel, for its own file only", async () => {
    renderTable(makeProject(), englishSource)
    await waitFor(() => expect(layerFetches()).toContain("/bkp/v1/people/JHN.json"))
    // Another file's request is not this table's business.
    expect(requestBibleFilter("file-other", { kind: "mentions", entity: JESUS })).toBe(false)
    await waitFor(() => expect(requestBibleFilter(FILE_ID, { kind: "mentions", entity: SAMARITAN_WOMAN })).toBe(true))
    const banner = await screen.findByTestId("voice-filter-banner")
    // The woman is mentioned in 4:7, 4:9 and 4:10; 4:6 and 4:8 do not mention her.
    expect(visible(banner.textContent)).toContain("Showing 3 cells that mention Samaritan woman")
    act(() => {
      requestBibleFilter(FILE_ID, null)
    })
    expect(screen.queryByTestId("voice-filter-banner")).toBeNull()
  })
})

describe("off means off", () => {
  it("shows no tints when Who's Who is off, while the Context tab stays", async () => {
    renderTable(makeProject({ bibleEnrichments: { "whos-who": false } }))
    const tab = await openContextTab(cellIdFor("4:10"))
    expect(within(tab).getByText("αὐτὸν")).toBeTruthy()
    expect(allMentions()).toEqual([])
    // No passage layer for a feature that is off.
    expect(layerFetches()).not.toContain("/bkp/v1/structure/JHN.json")
  })

  it("offers no Context tab when Original-language context is off, while the tints stay", async () => {
    renderTable(makeProject({ bibleEnrichments: { "original-context": false } }))
    await mentionsLoaded()
    fireEvent.click(within(row(cellIdFor("4:10"))).getByRole("button", { name: "Open cell details" }))
    await waitFor(() => expect(within(row(cellIdFor("4:10"))).getAllByRole("tab").length).toBeGreaterThan(0))
    expect(within(row(cellIdFor("4:10"))).queryByRole("tab", { name: /Context/ })).toBeNull()
  })

  it("removes the tints live when Who's Who is switched off, without a reload", async () => {
    const { rerender } = renderTable(makeProject())
    await mentionsLoaded()
    rerender(makeProject({ bibleEnrichments: { "whos-who": false } }))
    // The Context tab still needs the people layer: let that reload settle,
    // so the check is on where things end up, not on a loading moment.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(allMentions()).toEqual([])
    expect(row(cellIdFor("4:10")).textContent).toContain("αὐτὸν")
  })

  // AQU-1685: the experiment is device-local and off by default, and any
  // other EditorTable mount passes no `bibleOpen`. Either way the editor is as
  // it was before the pack, and the pack's servers see no request.
  it.each([
    ["with the Bible data experiment off", { experimentalFlags: {} }, true],
    ["when no Bible is open", {}, false],
  ] as const)("shows no tints and no Context tab, and fetches nothing, %s", async (_, overrides, bibleOpen) => {
    renderTable(makeProject(overrides), greekSource, makeRows(greekSource), bibleOpen)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(allMentions()).toEqual([])
    fireEvent.click(within(row(cellIdFor("4:10"))).getByRole("button", { name: "Open cell details" }))
    await waitFor(() => expect(within(row(cellIdFor("4:10"))).getAllByRole("tab").length).toBeGreaterThan(0))
    expect(within(row(cellIdFor("4:10"))).queryByRole("tab", { name: /Context/ })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches no people data when Bible data itself is off", async () => {
    renderTable(makeProject({ bibleResourcesEnabled: false }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(allMentions()).toEqual([])
    expect(layerFetches()).toEqual([])
  })
})
