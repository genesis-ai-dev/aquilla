/**
 * AQU-1695 — the Who's Who panel on Bible Knowledge Pack 1.1 data.
 *
 * Through the real pack client over a stubbed fetch (real pack 1.1.0 data
 * for John). What it protects, in the translator's terms:
 *   • a participant's description reads in the interface language when the
 *     pack has one, and in English (marked as English) when it does not;
 *   • their family is listed, and a relative the book mentions takes the
 *     editor to that first mention; one it never mentions is plain text;
 *   • a thing ("water", pack 1.1's `local-thing`) is listed apart and never
 *     flagged, however it is referred to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { WhosWhoSidebar } from "./WhosWhoSidebar"
import { onMentionJumpRequest } from "./bible-data-bus"
import { JHN4_STRUCTURE_JSON } from "@/lib/bible-data/__fixtures__/jhn4"
import {
  ISRAEL,
  JHN4_11_PEOPLE_JSON,
  JHN4_11_TEXT_JSON,
  LEVI_3,
  WATER,
  jhn4People11,
} from "@/lib/bible-data/__fixtures__/jhn4-pack11"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import type { BkpPeopleLayer } from "@/lib/bible-data/pack-types"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { writeStoredLocale } from "@/lib/i18n/store"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"

const MANIFEST = {
  pack: "bkp",
  version: "1.1.0",
  builtAt: "2026-10-06T07:29:11.834Z",
  versification: "org",
  sources: [],
  layers: {},
  books: { JHN: { layers: ["text", "structure", "voices", "people", "notes", "terms"], bytes: {} } },
}

let people = JHN4_11_PEOPLE_JSON
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  if (path.endsWith("/people/JHN.json")) return new Response(people, { status: 200 })
  if (path.endsWith("/text/JHN.json")) return new Response(JHN4_11_TEXT_JSON, { status: 200 })
  if (path.endsWith("/structure/JHN.json")) return new Response(JHN4_STRUCTURE_JSON, { status: 200 })
  return new Response("missing", { status: 404 })
})

const FILE_ID = "file-jhn"
const PROJECT: ProjectRecord = {
  id: "proj-1",
  name: "Injil Yohanes",
  sourceLanguage: "grc",
  targetLanguage: "id",
  createdAt: "2026-01-01T00:00:00Z",
  files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
  members: [],
}

/** The panel at JHN 4:10, in the 4:1–26 pericope, with the interface in `locale`. */
function renderPanel(locale = "en") {
  writeStoredLocale(locale)
  render(
    <I18nProvider>
      <WhosWhoSidebar
        project={PROJECT}
        fileId={FILE_ID}
        trackedRef="JHN 4:10"
        sourceLanguage="grc"
        open
        onToggle={() => {}}
      />
    </I18nProvider>,
  )
}

async function participant(entity: string): Promise<HTMLElement> {
  await screen.findByTestId("whos-who-passage")
  const found = screen.getAllByTestId("whos-who-participant").find((el) => el.dataset.entity === entity)
  if (!found) throw new Error(`no row for ${entity}`)
  return found
}

/** Bidi isolates are invisible; strip them to compare text. */
const visible = (value: string | null | undefined) => (value ?? "").replace(/[⁨⁩]/g, "")

const JACOB_ENGLISH = jhn4People11().entities[ISRAEL].descriptions?.eng

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  people = JHN4_11_PEOPLE_JSON
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a participant's description", () => {
  it("falls back to English, marked as English, when the interface language has none", async () => {
    // Pack 1.1.0's descriptions are English only.
    renderPanel("fr")
    const description = within(await participant(ISRAEL)).getByTestId("entity-description")
    expect(description.textContent).toBe(JACOB_ENGLISH)
    expect(description.getAttribute("lang")).toBe("en")
  })

  it("reads in the interface language when the pack has it", async () => {
    const withFrench = JSON.parse(JHN4_11_PEOPLE_JSON) as BkpPeopleLayer
    withFrench.entities[ISRAEL].descriptions = { ...withFrench.entities[ISRAEL].descriptions, fra: "Appelé d'abord Jacob." }
    people = JSON.stringify(withFrench)
    renderPanel("fr")
    const description = within(await participant(ISRAEL)).getByTestId("entity-description")
    expect(description.textContent).toBe("Appelé d'abord Jacob.")
    expect(description.getAttribute("lang")).toBe("fr")
  })
})

describe("a participant's family", () => {
  it("takes the editor to the first mention of a relative the book mentions, and lists one it never mentions as text", async () => {
    const jumps: string[] = []
    const stop = onMentionJumpRequest(FILE_ID, (ref) => jumps.push(ref))
    renderPanel()
    const kin = within(await participant(ISRAEL)).getByTestId("entity-kin")
    expect(within(kin).getByText("Children")).toBeTruthy()
    fireEvent.click(
      within(kin).getByRole("button", { name: (name) => visible(name) === "Go to the first mention of Joseph, JHN 4:5" }),
    )
    expect(jumps).toEqual(["JHN 4:5"])
    // Levi is Jacob's son in ACAI, but this book never mentions him: nowhere to go.
    const levi = kin.querySelector(`[data-kin="${LEVI_3}"]`)
    expect(visible(levi?.textContent)).toBe("Levi")
    expect(levi?.querySelector("button")).toBeNull()
    stop()
  })
})

describe("a thing", () => {
  it("lists water apart from the people, never flagged", async () => {
    renderPanel()
    await participant(ISRAEL)
    expect(screen.getAllByTestId("whos-who-participant").map((el) => el.dataset.entity)).not.toContain(WATER)
    const others = screen.getByTestId("whos-who-others")
    expect(within(others).getByRole("button", { name: (name) => visible(name).includes("water") })).toBeTruthy()
    for (const flag of screen.queryAllByTestId("whos-who-flag")) {
      expect(visible(flag.textContent)).not.toContain("water")
    }
  })
})
