/**
 * AQU-1700 — the Who's Who panel on the Old Testament, with real pack 1.2.0
 * data for Ruth and Genesis (src/lib/bible-data/__fixtures__/ot-pack12.ts).
 *
 * What it protects, in the translator's terms:
 *   • in Ruth, which the pack divides into passages (SIL Open Translator's
 *     Notes sections), the panel shows the passage in view, titled, with its
 *     people;
 *   • in Genesis, which it does not divide, the panel shows the chapter in
 *     view and its people, as quietly as a passage: no "no passage data", no
 *     error, no empty panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { WhosWhoSidebar } from "./WhosWhoSidebar"
import {
  LORD,
  NAOMI,
  OT_PACK12_FILES,
  OT_PACK12_MANIFEST,
  RUTH,
  SERPENT,
} from "@/lib/bible-data/__fixtures__/ot-pack12"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"

const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(OT_PACK12_MANIFEST)
  const file = Object.entries(OT_PACK12_FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

function renderPanel(trackedRef: string) {
  const book = trackedRef.split(" ")[0]
  const project: ProjectRecord = {
    id: "proj-1",
    name: "Perjanjian Lama",
    sourceLanguage: "hbo",
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: `file-${book}`, name: book, type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
  }
  render(
    <WhosWhoSidebar
      project={project}
      fileId={`file-${book}`}
      trackedRef={trackedRef}
      sourceLanguage="hbo"
      open
      onToggle={() => {}}
    />,
  )
}

/** Bidi isolates are invisible; strip them to compare text. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

const castEntities = () => screen.getAllByTestId("whos-who-participant").map((el) => el.dataset.entity)

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

describe("the passage in view, in an OT book", () => {
  it("shows Ruth's SIL OTN section around RUT 1:16, titled, with Naomi and Ruth", async () => {
    renderPanel("RUT 1:16")
    expect((await screen.findByTestId("whos-who-passage")).textContent).toBe("Naomi returned to Bethlehem with Ruth")
    expect(visible(screen.getByTestId("whos-who-range").textContent)).toBe("RUT 1:6–RUT 1:22")
    expect(castEntities()).toEqual(expect.arrayContaining([NAOMI, RUTH]))
  })

  it("falls back to GEN 3, the chapter in view, where the pack has no passages, and says nothing about it", async () => {
    renderPanel("GEN 3:1")
    const range = await screen.findByTestId("whos-who-range")
    expect(visible(range.textContent)).toBe("GEN 3:1–GEN 3:24")
    // A chapter has no title to show, and nothing tells the translator data is missing.
    expect(screen.queryByTestId("whos-who-passage")).toBeNull()
    const panel = screen.getByTestId("whos-who-panel")
    expect(panel.textContent).not.toMatch(/No passage data|could not be read|no Bible data/i)
    // Its people: Adam and the LORD God first, and the serpent.
    expect(castEntities().slice(0, 2)).toEqual(["person:Adam", LORD])
    expect(castEntities()).toContain(SERPENT)
  })
})
