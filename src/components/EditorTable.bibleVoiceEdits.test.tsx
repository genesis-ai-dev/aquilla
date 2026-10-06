/**
 * AQU-1692 — the Voices follow-ups in the editor, through the real pack client
 * on real Bible Knowledge Pack 1.2.0 data for Ruth
 * (src/lib/bible-data/__fixtures__/ot-pack12.ts). What it protects, from
 * aquilla-specs 05-user-stories/see-who-is-speaking.md (Error / edge cases):
 *   • where the data is unsure who speaks (RUT 1:10: FCBH and Macula disagree),
 *     the chip marks the speaker "check" and the popover says why; a sure
 *     speaker (RUT 1:8) is not marked, or the marker would mean nothing;
 *   • a speech whose boundary scholars dispute is marked on the chip itself,
 *     not only in the popover;
 *   • a maintainer's correction is what the chip shows, says who made it and
 *     what the Bible data said; only a maintainer is offered "Correct …", and
 *     the dialog saves exactly the choice made;
 *   • "Adopt voices as cast" shows its counts before writing, sends only the
 *     lines one voice reads, and keeps a cast name the project already set;
 *   • a book opened offline, with nothing cached, loads once the connection
 *     is back (it used to stay empty until the file was reopened), and View
 *     settings is told why it is empty meanwhile; a loaded book is not fetched
 *     again; a correction whose speech the pack no longer has is reported;
 *   • none of it shows, and nothing is fetched, without the Bible data
 *     experiment (AQU-1685), even for a maintainer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { EditorTable } from "./EditorTable"
import type { SaveVoiceOverride } from "./bible-data/use-voice-override-writer"
import type { VoiceCastAssignment } from "./bible-data/AdoptCastDialog"
import { useBiblePackStatus } from "./bible-data/bible-data-bus"
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

const MAINTAINER = { level: 600, name: "maintainer", source: "test", fetchedAt: "2026-10-06T00:00:00Z" }
const CONTRIBUTOR = { ...MAINTAINER, level: 400, name: "contributor" }

/** RUT 1:10, "No, we will return with you": FCBH says Orpah, Macula disagrees. */
const ORPAH_1_10 = "sp:o080010100041-o080010100063"

interface RenderOptions {
  project?: ProjectRecord
  bibleOpen?: boolean
  metadata?: Record<string, Record<string, unknown>>
  onSaveVoiceOverride?: SaveVoiceOverride
  onAdoptVoicesAsCast?: (assignments: readonly VoiceCastAssignment[]) => void
}

function renderRuth({
  project = makeProject(),
  bibleOpen = true,
  metadata = {},
  onSaveVoiceOverride,
  onAdoptVoicesAsCast,
}: RenderOptions = {}) {
  const store = new CellStore()
  store.setRuntime({ projectId: "proj-1", fileId: "file-RUT", username: "tester", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(makeRows(metadata), { full: true, maxServerSeq: 1 })
  return render(
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
          onSaveVoiceOverride={onSaveVoiceOverride}
          onAdoptVoicesAsCast={onAdoptVoicesAsCast}
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

describe("a maintainer's correction", () => {
  const corrected = {
    [ORPAH_1_10]: { speaker: "person:Ruth", note: "Both daughters-in-law answer; we follow Ruth.", by: "mara", at: "2026-10-06T12:00:00Z" },
  }

  it("is what the chip shows, and the popover says who made it, why, and what the Bible data said", async () => {
    renderRuth({ project: makeProject({ bibleVoiceOverrides: corrected }) })
    const marked = await chip(rut("1:10"))
    await waitFor(() => expect(visible(marked.textContent)).toContain("Ruth"))
    expect(marked.querySelector("[data-voice-check]")).toBeNull()

    const details = await openDetails(rut("1:10"))
    expect(visible(within(details).getByTestId("voice-corrected").textContent)).toMatch(/^Corrected by mara on /)
    expect(details.textContent).toContain("Both daughters-in-law answer; we follow Ruth.")
    expect(visible(details.textContent)).toContain("Bible data: Orpah to Naomi")
  })

  it("is offered to a maintainer, and not to a contributor or where there is nowhere to save it", async () => {
    const save: SaveVoiceOverride = vi.fn(async () => ({ kind: "ok" as const }))
    const contributor = renderRuth({ project: makeProject({ syncRole: CONTRIBUTOR }), onSaveVoiceOverride: save })
    expect(within(await openDetails(rut("1:10"))).queryByRole("button", { name: "Correct speaker or listener" })).toBeNull()
    contributor.unmount()

    const nowhere = renderRuth({ project: makeProject({ syncRole: MAINTAINER }) })
    expect(within(await openDetails(rut("1:10"))).queryByRole("button", { name: "Correct speaker or listener" })).toBeNull()
    nowhere.unmount()

    renderRuth({ project: makeProject({ syncRole: MAINTAINER }), onSaveVoiceOverride: save })
    expect(within(await openDetails(rut("1:10"))).getByRole("button", { name: "Correct speaker or listener" })).toBeTruthy()
  })

  it("saves the maintainer's choice and reason for that speech, and closes", async () => {
    const save = vi.fn<SaveVoiceOverride>(async () => ({ kind: "ok" as const }))
    renderRuth({ project: makeProject({ syncRole: MAINTAINER }), onSaveVoiceOverride: save })
    fireEvent.click(within(await openDetails(rut("1:10"))).getByRole("button", { name: "Correct speaker or listener" }))

    const dialog = await screen.findByTestId("voice-override-dialog")
    const saveButton = within(dialog).getByRole("button", { name: "Save correction" }) as HTMLButtonElement
    fireEvent.change(within(dialog).getByLabelText("Speaker"), { target: { value: "person:Ruth" } })
    // No reason yet: a correction nobody can review later is not saved.
    expect(saveButton.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "  We follow Ruth.  " } })
    fireEvent.click(saveButton)

    await waitFor(() => expect(save).toHaveBeenCalledWith(ORPAH_1_10, { speaker: "person:Ruth", note: "We follow Ruth." }))
    await waitFor(() => expect(screen.queryByTestId("voice-override-dialog")).toBeNull())
  })

  it("stays open and says why when the server refuses", async () => {
    const save = vi.fn<SaveVoiceOverride>(async () => ({ kind: "blocked" as const, reason: "role" as const }))
    renderRuth({ project: makeProject({ syncRole: MAINTAINER, bibleVoiceOverrides: corrected }), onSaveVoiceOverride: save })
    fireEvent.click(within(await openDetails(rut("1:10"))).getByRole("button", { name: "Edit correction" }))

    const dialog = await screen.findByTestId("voice-override-dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove correction" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(ORPAH_1_10, null))
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Only maintainers can correct who is speaking.")
  })
})

describe("adopting the voices as the cast", () => {
  it("counts first, then sends only the lines one voice reads, keeping a cast name already set", async () => {
    const adopt = vi.fn<(assignments: readonly VoiceCastAssignment[]) => void>()
    renderRuth({
      project: makeProject({ syncRole: MAINTAINER }),
      // RUT 1:9 already has a character; it keeps the row-corner slot, so it has no chip.
      metadata: { [rut("1:9")]: { cast_name: "Naomi (older)" } },
      onAdoptVoicesAsCast: adopt,
    })
    fireEvent.click(within(await openDetails(rut("1:17"))).getByRole("button", { name: "Adopt voices as cast" }))

    const dialog = await screen.findByTestId("adopt-cast-dialog")
    // RUT 1 here: 1:17 is Ruth alone; 1:8, 1:10 and 1:16 have the narrator and a speaker.
    expect(within(dialog).getByTestId("adopt-cast-count").textContent).toBe("1 line gets a character.")
    expect(visible(within(dialog).getByTestId("bibleVoices.cast.skippedSeveral").textContent)).toContain(
      "RUT 1:16: Narrator, Ruth",
    )
    expect(visible(within(dialog).getByTestId("bibleVoices.cast.keptExisting").textContent)).toContain(
      "RUT 1:9: Naomi (older)",
    )
    expect(adopt).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Adopt 1 line" }))
    expect(adopt).toHaveBeenCalledWith([{ cellId: rut("1:17"), castName: "Ruth" }])
  })

  it("is not offered below maintainer, the floor of a cast assignment", async () => {
    renderRuth({ project: makeProject({ syncRole: CONTRIBUTOR }), onAdoptVoicesAsCast: vi.fn() })
    expect(within(await openDetails(rut("1:17"))).queryByRole("button", { name: "Adopt voices as cast" })).toBeNull()
  })
})

describe("loading after reconnecting", () => {
  it("loads a book opened offline once the connection is back, and says why it is empty meanwhile", async () => {
    offline = true
    renderRuth()
    const status = renderHook(() => useBiblePackStatus("file-RUT"))
    await waitFor(() => expect(status.result.current?.failure).toBe("offline"))
    expect(chipIn(rut("1:8"))).toBeNull()

    offline = false
    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    await chip(rut("1:8"))
    await waitFor(() => expect(status.result.current?.failure).toBeNull())
  })

  it("does not fetch a loaded book again", async () => {
    renderRuth()
    await chip(rut("1:8"))
    fetchMock.mockClear()
    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports a correction whose speech the pack no longer has", async () => {
    const moved = "sp:o080010100041-o080010100070"
    renderRuth({
      project: makeProject({
        bibleVoiceOverrides: { [moved]: { speaker: "person:Ruth", note: "Ours.", by: "mara", at: "2026-10-06T12:00:00Z" } },
      }),
    })
    const status = renderHook(() => useBiblePackStatus("file-RUT"))
    await waitFor(() => expect(status.result.current?.orphanedCorrections).toEqual([moved]))
  })
})

describe("the Bible data experiment (AQU-1685)", () => {
  it("shows no chip and fetches nothing while it is off, even for a maintainer who could correct", async () => {
    const save: SaveVoiceOverride = vi.fn(async () => ({ kind: "ok" as const }))
    renderRuth({ project: makeProject({ syncRole: MAINTAINER, experimentalFlags: {} }), onSaveVoiceOverride: save })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(chipIn(rut("1:10"))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

