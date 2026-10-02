// AQU-1573 — the Reference Bible card. The Bible list and the patch function
// are injected, so these pin the card's own behaviour: which lanes get a row,
// what each dropdown offers and in what order, and the exact setting value a
// choice writes (always a map; {} rather than null when the last lane is
// cleared, because the settings overlay skips null and would keep the old
// choice on screen).

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { ReferenceBibleSection } from "./ReferenceBibleSection"
import { referenceBibleLaneRows, sortBiblesForLane } from "./reference-bible-rows"
import type { ReferenceBibleSummary } from "@/lib/reference-bible/types"
import type { ProjectLaneView } from "@/lib/sync/project-settings"

function bible(id: string, name: string, languageCode: string, languageName: string): ReferenceBibleSummary {
  return {
    id, name, fullName: name, languageCode, languageName,
    direction: languageCode === "ar" ? "rtl" : "ltr",
    versification: "eng", printing: null, license: "Public domain", source: "eBible.org", verseCount: 31102,
  }
}

const VAN_DYCK = bible("arb-vandyck", "Van Dyck", "ar", "Arabic")
const KJV = bible("eng-kjv", "King James Version", "en", "English")

const LANES: ProjectLaneView[] = [
  { id: "l0", role: "target", name: "Arabic", langCode: "ar", legacyTag: "", position: 0, archivedAt: null },
  { id: "l1", role: "target", name: "Plain English", langCode: "en", legacyTag: "en", position: 1, archivedAt: null },
  { id: "l2", role: "target", name: "French", langCode: "fr", legacyTag: "fr", position: 2, archivedAt: "2026-09-01" },
]

function renderCard(overrides: Partial<Parameters<typeof ReferenceBibleSection>[0]> = {}) {
  const onPatch = vi.fn(async () => ({ kind: "ok" }))
  const props = {
    value: undefined as unknown,
    targetLanguage: "Arabic",
    targetLanes: ["Arabic", "en", "fr"],
    archivedLanes: ["fr"],
    laneRecords: LANES,
    loadVersions: () => Promise.resolve([KJV, VAN_DYCK]),
    onPatch,
    ...overrides,
  }
  const utils = render(<ReferenceBibleSection {...props} />)
  return { ...utils, onPatch }
}

/** Base UI Select: click does not commit under happy-dom — highlight + Enter. */
async function pick(trigger: HTMLElement, optionName: string) {
  fireEvent.click(trigger)
  const listbox = await screen.findByRole("listbox")
  const option = within(listbox).getByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("ReferenceBibleSection", () => {
  it("has one row per active lane, default first, archived lanes hidden", async () => {
    renderCard()
    expect(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Reference Bible for Plain English" })).toBeTruthy()
    expect(screen.queryByRole("combobox", { name: /French/ })).toBeNull()
    expect(screen.getByText("Default language")).toBeTruthy()
  })

  it("shows each lane's current Bible, the array form meaning the default lane", async () => {
    renderCard({ value: ["arb-vandyck"] })
    const arabic = await screen.findByRole("combobox", { name: "Reference Bible for Arabic" })
    expect(arabic).toHaveTextContent("Van Dyck (Arabic)")
    expect(screen.getByRole("combobox", { name: "Reference Bible for Plain English" })).toHaveTextContent("None")
  })

  it("offers None first, then the lane's own language before the others", async () => {
    renderCard()
    fireEvent.click(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" }))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "None", "Van Dyck (Arabic)", "King James Version (English)",
    ])
  })

  it("saves a choice straight away as a lane map", async () => {
    const { onPatch } = renderCard({ value: { "": "arb-vandyck" } })
    await pick(await screen.findByRole("combobox", { name: "Reference Bible for Plain English" }), "King James Version (English)")
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1))
    expect(onPatch).toHaveBeenCalledWith({ referenceBibleVersions: { "": "arb-vandyck", en: "eng-kjv" } })
  })

  it("rewrites an agent's language-name key as the default lane when changed", async () => {
    const { onPatch } = renderCard({ value: { Arabic: "eng-kjv" } })
    await pick(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" }), "Van Dyck (Arabic)")
    await waitFor(() => expect(onPatch).toHaveBeenCalled())
    expect(onPatch).toHaveBeenCalledWith({ referenceBibleVersions: { "": "arb-vandyck" } })
  })

  it('"None" on the last lane writes {} rather than null', async () => {
    const { onPatch } = renderCard({ value: ["arb-vandyck"] })
    await pick(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" }), "None")
    await waitFor(() => expect(onPatch).toHaveBeenCalled())
    expect(onPatch).toHaveBeenCalledWith({ referenceBibleVersions: {} })
  })

  it("names a stored Bible this server does not have instead of going blank", async () => {
    renderCard({ value: { "": "arb-svd" } })
    expect(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" })).toHaveTextContent(
      "arb-svd (not installed)",
    )
  })

  it("says so when no Bible is installed, and shows no dropdowns", async () => {
    renderCard({ loadVersions: () => Promise.resolve([]) })
    expect(await screen.findByTestId("reference-bible-none-installed")).toHaveTextContent(
      "No reference Bibles are installed on this server yet.",
    )
    expect(screen.queryByRole("combobox")).toBeNull()
  })

  it("says so when the list cannot be loaded", async () => {
    renderCard({ loadVersions: () => Promise.reject(new Error("offline")) })
    expect(await screen.findByText(/Could not load the list of Bibles/)).toBeTruthy()
  })

  it("is read-only for someone who cannot edit shared settings", async () => {
    renderCard({ disabled: true, disabledTooltip: "Only Maintainers can modify" })
    const trigger = await screen.findByRole("combobox", { name: "Reference Bible for Arabic" })
    expect(trigger).toHaveAttribute("data-disabled")
  })

  it("shows the save error under the lane that failed", async () => {
    const onPatch = vi.fn(async () => ({ kind: "error", message: "Server said no" }))
    renderCard({ onPatch })
    await pick(await screen.findByRole("combobox", { name: "Reference Bible for Arabic" }), "Van Dyck (Arabic)")
    expect(await screen.findByText("Server said no")).toBeTruthy()
  })
})

describe("referenceBibleLaneRows", () => {
  it("falls back to the tag and the target language without lane records", () => {
    expect(referenceBibleLaneRows("Arabic", ["Arabic", "en"], [], undefined)).toEqual([
      { tag: "", label: "Arabic", language: "Arabic" },
      { tag: "en", label: "en", language: "en" },
    ])
  })
})

describe("sortBiblesForLane", () => {
  it("matches a lane language by code or by name", () => {
    expect(sortBiblesForLane([KJV, VAN_DYCK], "Arabic").map((v) => v.id)).toEqual(["arb-vandyck", "eng-kjv"])
    expect(sortBiblesForLane([VAN_DYCK, KJV], "en").map((v) => v.id)).toEqual(["eng-kjv", "arb-vandyck"])
    expect(sortBiblesForLane([KJV, VAN_DYCK], "fr").map((v) => v.id)).toEqual(["eng-kjv", "arb-vandyck"])
  })
})
