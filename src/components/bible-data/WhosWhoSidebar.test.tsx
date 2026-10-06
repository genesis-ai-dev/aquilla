/**
 * AQU-1689 — the Who's Who panel: the cast of the passage in view.
 *
 * Through the real pack client over a stubbed fetch (real JHN 4 and MRK 1
 * data). What it protects, in the translator's terms:
 *   • the panel lists the people of the PASSAGE in view (the pericope), with
 *     how often each is referred to, and groups as groups;
 *   • the two flags appear on the participant they concern, in words, and
 *     take the translator to the verse;
 *   • choosing a participant asks the editor to filter, and the panel shows
 *     which participant is filtering; jumps go to the editor too;
 *   • on an English source it says that word highlights need an alignment;
 *   • closed, it is a "People" tab that reads nothing; offline, it says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { WhosWhoSidebar } from "./WhosWhoSidebar"
import { onBibleFilterRequest, onMentionJumpRequest, publishBibleFilter } from "./bible-data-bus"
import {
  JESUS,
  JHN4_PEOPLE_JSON,
  JHN4_STRUCTURE_JSON,
  JHN4_TEXT_JSON,
  SAMARITAN_WOMAN,
  DISCIPLES_4_8,
} from "@/lib/bible-data/__fixtures__/jhn4"
import { MRK1_PEOPLE_JSON, MRK1_STRUCTURE_JSON, MRK1_TEXT_JSON } from "@/lib/bible-data/__fixtures__/mrk1"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"

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

let offline = false
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  if (offline) throw new TypeError("Failed to fetch")
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

const FILE_ID = "file-jhn"
const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Injil Yohanes",
  sourceLanguage: "en",
  targetLanguage: "id",
  createdAt: "2026-01-01T00:00:00Z",
  files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
  members: [],
}

function renderPanel(props: { trackedRef?: string | null; sourceLanguage?: string; open?: boolean } = {}) {
  const onToggle = vi.fn()
  render(
    <WhosWhoSidebar
      project={PROJECT}
      fileId={FILE_ID}
      trackedRef={props.trackedRef === undefined ? "JHN 4:10" : props.trackedRef}
      sourceLanguage={props.sourceLanguage ?? "en"}
      open={props.open ?? true}
      onToggle={onToggle}
    />,
  )
  return { onToggle }
}

/** Bidi isolates are invisible; strip them to compare text. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

function participant(entity: string): HTMLElement {
  const found = screen
    .getAllByTestId("whos-who-participant")
    .find((el) => el.dataset.entity === entity)
  if (!found) throw new Error(`no row for ${entity}`)
  return found
}

async function castLoaded() {
  await screen.findByTestId("whos-who-passage")
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

describe("the cast of the passage in view", () => {
  it("names the pericope and lists Jesus, the Samaritan woman and the disciples as a group", async () => {
    renderPanel({ trackedRef: "JHN 4:10" })
    await castLoaded()
    expect(screen.getByTestId("whos-who-passage").textContent).toBe("Christ and the Woman of Samaria")
    // The refs are bidi-isolated inside the range.
    const range = screen.getByTestId("whos-who-passage").nextElementSibling
    expect(visible(range?.textContent)).toBe("JHN 4:1–JHN 4:26")

    const rows = screen.getAllByTestId("whos-who-participant").map((el) => el.dataset.entity)
    expect(rows.slice(0, 2).sort()).toEqual([JESUS, SAMARITAN_WOMAN].sort())
    expect(rows).toContain(DISCIPLES_4_8)

    // Real counts for JHN 4:1–26: every name, pronoun and implied subject.
    expect(visible(participant(JESUS).textContent)).toContain("47 mentions")
    expect(visible(participant(JESUS).textContent)).toContain("male · singular")
    expect(visible(participant(SAMARITAN_WOMAN).textContent)).toContain("feminine (grammatical gender) · singular")
    expect(visible(participant(DISCIPLES_4_8).textContent)).toContain("plural")
  })

  it("lists places apart from the people", async () => {
    renderPanel({ trackedRef: "JHN 4:10" })
    await castLoaded()
    const others = screen.getByTestId("whos-who-others")
    expect(within(others).getByText(/places and other references/)).toBeTruthy()
    expect(visible(others.textContent)).toContain("Samaria (City)")
    expect(screen.getAllByTestId("whos-who-participant").map((el) => el.dataset.entity)).not.toContain("place:Samaria")
  })

  it("follows the editor into the next pericope", async () => {
    renderPanel({ trackedRef: "JHN 4:27" })
    await castLoaded()
    expect(screen.getByTestId("whos-who-passage").textContent).toBe("The Samaritans Believe")
  })
})

describe("flags", () => {
  // Real data: JHN 4:27 opens "The Samaritans Believe" with "his disciples";
  // a reader who starts there meets "his" before Jesus's name.
  it("asks to name Jesus again where the passage first calls him 'his', and jumps there", async () => {
    const jumps = vi.fn()
    const stop = onMentionJumpRequest(FILE_ID, jumps)
    renderPanel({ trackedRef: "JHN 4:27" })
    await castLoaded()
    const flag = within(participant(JESUS))
      .getAllByTestId("whos-who-flag")
      .find((el) => el.dataset.flag === "reintroduce")
    if (!flag) throw new Error("no re-introduce flag on Jesus")
    expect(visible(flag.textContent)).toBe(
      "Name them again: this passage first refers to them with a pronoun, at JHN 4:27.",
    )
    fireEvent.click(flag)
    expect(jumps).toHaveBeenCalledWith("JHN 4:27")
    stop()
  })

  // Real data: MRK 1:30, "they speak to him about her", in a verse that also
  // names Simon (Peter). Both are men, both singular.
  it("says which pronoun may be read as somebody else", async () => {
    render(
      <WhosWhoSidebar
        project={PROJECT}
        fileId="file-mrk"
        trackedRef="MRK 1:30"
        sourceLanguage="en"
        open
        onToggle={() => {}}
      />,
    )
    await castLoaded()
    const flags = within(participant(JESUS))
      .getAllByTestId("whos-who-flag")
      .filter((el) => el.dataset.flag === "possible-ambiguity")
    expect(flags.map((el) => visible(el.textContent))).toContain("A pronoun at MRK 1:30 may be read as Peter.")
  })
})

describe("talking to the editor", () => {
  it("asks the editor to filter to a participant, shows who is filtering, and asks to stop", async () => {
    const requests = vi.fn()
    const stop = onBibleFilterRequest(FILE_ID, requests)
    renderPanel()
    await castLoaded()
    const jesus = within(participant(JESUS)).getByRole("button", { name: /^Show cells that mention/ })
    expect(visible(jesus.getAttribute("aria-label"))).toBe("Show cells that mention Jesus")
    expect(jesus.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(jesus)
    expect(requests).toHaveBeenLastCalledWith({ kind: "mentions", entity: JESUS })

    // The editor applies it and says so.
    act(() => publishBibleFilter(FILE_ID, { kind: "mentions", entity: JESUS }))
    expect(jesus.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(jesus)
    expect(requests).toHaveBeenLastCalledWith(null)

    act(() => publishBibleFilter(FILE_ID, null))
    stop()
  })

  it("asks the editor for the first mention, and for the next one from where it is", async () => {
    const jumps = vi.fn()
    const stop = onMentionJumpRequest(FILE_ID, jumps)
    renderPanel({ trackedRef: "JHN 4:10" })
    await castLoaded()
    fireEvent.click(within(participant(JESUS)).getByRole("button", { name: /^Go to the first mention of/ }))
    expect(jumps).toHaveBeenLastCalledWith("JHN 4:1")
    fireEvent.click(within(participant(JESUS)).getByRole("button", { name: /^Next mention of/ }))
    expect(jumps).toHaveBeenLastCalledWith("JHN 4:11")
    fireEvent.click(within(participant(JESUS)).getByRole("button", { name: /^Previous mention of/ }))
    expect(jumps).toHaveBeenLastCalledWith("JHN 4:9")
    stop()
  })
})

describe("what it says around the cast", () => {
  it("says word highlights need an alignment on an English source, and not on a Greek one", async () => {
    renderPanel({ sourceLanguage: "en" })
    await castLoaded()
    expect(screen.getByTestId("whos-who-alignment-note")).toBeTruthy()
  })

  it("has no alignment note on a Greek source", async () => {
    renderPanel({ sourceLanguage: "grc" })
    await castLoaded()
    expect(screen.queryByTestId("whos-who-alignment-note")).toBeNull()
  })

  it("asks for a verse before the editor shows one", () => {
    renderPanel({ trackedRef: null })
    expect(screen.getByText("Scroll to a verse to see who is in its passage.")).toBeTruthy()
  })

  it("says the data is not available offline, without throwing", async () => {
    offline = true
    renderPanel()
    expect(
      await screen.findByText("Bible data for this book is not available offline yet. Try again when you are online."),
    ).toBeTruthy()
  })

  it("is a People tab that reads nothing while closed", async () => {
    const { onToggle } = renderPanel({ open: false })
    const tab = screen.getByRole("button", { name: "Show Who's Who" })
    expect(tab.textContent).toContain("People")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(tab)
    expect(onToggle).toHaveBeenCalled()
  })

  it("closes from its own button", async () => {
    const { onToggle } = renderPanel()
    await waitFor(() => screen.getByTestId("whos-who-panel"))
    fireEvent.click(screen.getByRole("button", { name: "Hide Who's Who" }))
    expect(onToggle).toHaveBeenCalled()
  })
})
