/**
 * AQU-1700 — Old Testament pronouns placed by the word alignment draw dotted.
 *
 * Hebrew pronouns, and above all the pronominal suffixes, are placed by
 * Bridge 1 less reliably than AQU-1694's bar for a solid tint (about 85% of
 * links at confidence 0.5 or above right; GEN measured 77.6%, John's Greek
 * 92.2%). So on an English (BSB) source, RUT 1:16's "me", the suffix ־ִי of
 * בִּי, draws as approximate even when its stored link is 0.9 sure, while the
 * name "Ruth" beside it, and John's "Me" (μοι) at the same confidence, draw
 * solid. Real pack data (src/lib/bible-data/__fixtures__/ot-pack12.ts and
 * jhn4.ts), the real BSB verses (public domain), and stored links served the
 * way the sync-worker's source-word-alignment route serves them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import { __resetSourceAlignmentStore } from "./bible-data/source-alignment-store"
import { EditorActionsProvider } from "@/context/EditorActionsContext"
import { CellStore } from "@/hooks/useActiveCellStore"
import { JESUS, JHN4_PEOPLE_JSON, JHN4_STRUCTURE_JSON, JHN4_TEXT_JSON } from "@/lib/bible-data/__fixtures__/jhn4"
import { ME_1_16, OT_PACK12_FILES, OT_PACK12_MANIFEST, RUTH } from "@/lib/bible-data/__fixtures__/ot-pack12"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import { tokenize } from "@/lib/completion/tokenize"
import { contentHash } from "@/lib/dcs/content-hash"
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

// A stall watchdog, not a speed bar (AGENTS.md rule 15).
const LOAD = { timeout: 10_000 }

/** One verse of a file whose source is the BSB, with what a maintainer's alignment run stored for it. */
interface Case {
  book: string
  ref: string
  bsb: string
  /** Pack word → the BSB word it is linked to, at confidence 0.9. */
  links: readonly (readonly [string, string])[]
}

const RUT_1_16: Case = {
  book: "RUT",
  ref: "RUT 1:16",
  bsb: "But Ruth replied: “Do not urge me to leave you or to turn from following you. For wherever you go, I will go, and wherever you live, I will live; your people will be my people, and your God will be my God.",
  links: [
    ["o080010160021", "ruth"], // רוּת
    [ME_1_16, "me"], // the suffix ־ִי of בִּי
  ],
}

const JHN_4_7: Case = {
  book: "JHN",
  ref: "JHN 4:7",
  bsb: "When a Samaritan woman came to draw water, Jesus said to her, “Give Me a drink.”",
  links: [["n43004007013", "me"]], // μοι
}

const cellIdOf = (ref: string) => `cell-${ref.replace(/[ :]/g, "-")}`

/** The rows the route returns: links by token index, 0.9 sure, from a book-sized training run. */
function storedAlignment(c: Case) {
  const tokens = tokenize(c.bsb)
  return {
    cells: [
      {
        cellId: cellIdOf(c.ref),
        sourceHash: contentHash(c.bsb),
        method: "ibm1-gdfa-names/1",
        trainedPairs: 878,
        stale: false,
        links: c.links.map(([wordId, word]) => [wordId, tokens.indexOf(word), 0.9]),
      },
    ],
  }
}

const MANIFEST = {
  ...OT_PACK12_MANIFEST,
  books: { ...OT_PACK12_MANIFEST.books, JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
}
const FILES: Readonly<Record<string, string>> = {
  ...OT_PACK12_FILES,
  "/people/JHN.json": JHN4_PEOPLE_JSON,
  "/text/JHN.json": JHN4_TEXT_JSON,
  "/structure/JHN.json": JHN4_STRUCTURE_JSON,
}

let current: Case = RUT_1_16
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/source-word-alignment")) return Response.json(storedAlignment(current))
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

function renderVerse(c: Case) {
  current = c
  const id = cellIdOf(c.ref)
  const fileId = `file-${c.book}`
  const shared = { cellId: id, valueHtml: null, type: "text", canonicalRef: c.ref, anchorCellId: null, wordCount: 1 }
  const rows = [
    { ...shared, side: "source", value: c.bsb, eventId: `${id}-s`, sourceEventId: null, lastEditor: null, lastEditAt: 1, validated: false },
    { ...shared, side: "target", value: "", eventId: `${id}-t`, sourceEventId: `${id}-s`, lastEditor: null, lastEditAt: 2, validated: false },
  ] satisfies CellRow[]
  const project: ProjectRecord = {
    id: "proj-1",
    name: c.book,
    sourceLanguage: "en",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: fileId, name: c.book, type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
  }
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId, username: "tester", requiredValidations: 1, auditStats: new Map() })
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
        />
      </EditorActionsProvider>
    </QueryClientProvider>,
  )
}

/** The mention drawn on a source word, once the pack and the stored alignment are in. */
async function mentionOn(c: Case, word: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-cell-id="${cellIdOf(c.ref)}"][data-index]`)
    const found = [...(row?.querySelectorAll<HTMLElement>('[data-testid="mention"]') ?? [])].find(
      (el) => el.textContent === word,
    )
    if (!found) throw new Error(`no mention on "${word}" yet`)
    return found
  }, LOAD)
}

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  __resetSourceAlignmentStore()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a pronoun the alignment placed, Old Testament and New", () => {
  it("draws RUT 1:16's 'me' (Ruth, a Hebrew suffix) approximate at confidence 0.9, and 'Ruth' solid", async () => {
    renderVerse(RUT_1_16)
    const me = await mentionOn(RUT_1_16, "me")
    expect(me.dataset.mentionEntity).toBe(RUTH)
    expect(me.dataset.mentionKind).toBe("pronoun")
    expect(me.dataset.mentionApproximate).toBe("true")
    // The name beside it, linked as surely, is not affected: the rule is for pronouns.
    const ruth = await mentionOn(RUT_1_16, "Ruth")
    expect(ruth.dataset.mentionEntity).toBe(RUTH)
    expect(ruth.dataset.mentionApproximate).toBeUndefined()
  })

  it("draws John 4:7's 'Me' (Jesus, a Greek pronoun) solid at the same confidence", async () => {
    renderVerse(JHN_4_7)
    const me = await mentionOn(JHN_4_7, "Me")
    expect(me.dataset.mentionEntity).toBe(JESUS)
    expect(me.dataset.mentionKind).toBe("pronoun")
    expect(me.dataset.mentionApproximate).toBeUndefined()
  })
})
