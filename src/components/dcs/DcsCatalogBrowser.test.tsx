/**
 * DcsCatalogBrowser — Slice B smoke/behaviour.
 *
 * WHY each test matters:
 *  1. On mount the browser runs a default catalog search and lists the returned
 *     resources — an empty panel would strand the user (spec §9.1). The row shows
 *     the identifying facts (repo, release tag, subject) so a picker can choose.
 *  2. Picking a row hands the exact chosen entry back to the caller — this is the
 *     contract the ImportDialog relies on to run importDcsResource against the
 *     right repo@ref. A wrong/missing entry would import the wrong resource.
 *  3. Editing a filter and searching re-queries with the new params — the filters
 *     must actually drive the search, not just decorate it.
 *  4. A search error is surfaced, not swallowed — a silent failure would look like
 *     "no resources exist" and mislead the user (fail-loud).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"
import type { DcsCatalogEntry } from "@/lib/dcs/types"
import type { CatalogSearchParams } from "@/lib/dcs/catalog"
import { DcsCatalogBrowser } from "./DcsCatalogBrowser"

function entry(over: Partial<DcsCatalogEntry> = {}): DcsCatalogEntry {
  return {
    name: "en_ult",
    owner: "unfoldingWord",
    fullName: "unfoldingWord/en_ult",
    subject: "Aligned Bible",
    contentFormat: "usfm",
    ref: "v89",
    commitSha: "84c73ba0",
    released: "2026-06-23T22:01:02Z",
    zipballUrl: "https://git.door43.org/z.zip",
    metadataUrl: "https://git.door43.org/m.yaml",
    language: "en",
    languageTitle: "English",
    ...over,
  }
}

/** A stub standing in for DcsClient — only searchCatalog is exercised here. */
function makeClient(searchCatalog: (p: CatalogSearchParams) => Promise<DcsCatalogEntry[]>) {
  return { searchCatalog: vi.fn(searchCatalog) } as unknown as import("@/lib/dcs/catalog").DcsClient
}

describe("DcsCatalogBrowser", () => {
  beforeEach(() => vi.clearAllMocks())

  it("runs an initial search on mount and lists the returned resources", async () => {
    const client = makeClient(async () => [
      entry(),
      entry({ name: "en_ust", fullName: "unfoldingWord/en_ust", subject: "Aligned Bible", ref: "v89" }),
    ])

    await act(async () => {
      render(<DcsCatalogBrowser onPick={vi.fn()} client={client} />)
    })

    // Both repos rendered with their identifying facts.
    expect(await screen.findByText("unfoldingWord/en_ult")).toBeTruthy()
    expect(screen.getByText("unfoldingWord/en_ust")).toBeTruthy()
    // Release tag is shown so the user knows what they'll pin.
    expect(screen.getAllByText("v89").length).toBeGreaterThan(0)
    // Search actually ran.
    expect((client as unknown as { searchCatalog: ReturnType<typeof vi.fn> }).searchCatalog).toHaveBeenCalled()
  })

  it("hands the picked entry back to the caller unchanged", async () => {
    const picked = entry({ name: "en_ult", ref: "v89", commitSha: "deadbeef" })
    const client = makeClient(async () => [picked])
    const onPick = vi.fn()

    await act(async () => {
      render(<DcsCatalogBrowser onPick={onPick} client={client} />)
    })

    const row = await screen.findByText("unfoldingWord/en_ult")
    await act(async () => {
      fireEvent.click(row)
    })

    expect(onPick).toHaveBeenCalledTimes(1)
    // The exact entry object (incl. the pin-critical commitSha) is passed through.
    expect(onPick.mock.calls[0][0]).toMatchObject({ name: "en_ult", ref: "v89", commitSha: "deadbeef" })
  })

  it("re-queries with the edited language filter when Search is pressed", async () => {
    const client = makeClient(async () => [entry()])

    await act(async () => {
      render(<DcsCatalogBrowser onPick={vi.fn()} client={client} defaultLang="en" />)
    })
    await screen.findByText("unfoldingWord/en_ult")

    const langInput = screen.getByLabelText("Language code") as HTMLInputElement
    await act(async () => {
      fireEvent.change(langInput, { target: { value: "es-419" } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /search/i }))
    })

    const mock = (client as unknown as { searchCatalog: ReturnType<typeof vi.fn> }).searchCatalog
    // The most recent call carried the new language filter.
    const lastParams = mock.mock.calls[mock.mock.calls.length - 1][0] as CatalogSearchParams
    expect(lastParams.lang).toBe("es-419")
  })

  it("surfaces a search error instead of silently showing an empty list", async () => {
    const client = makeClient(async () => {
      throw new Error("DCS request failed (HTTP 500)")
    })

    await act(async () => {
      render(<DcsCatalogBrowser onPick={vi.fn()} client={client} />)
    })

    await waitFor(() => {
      expect(screen.getByText(/DCS request failed/i)).toBeTruthy()
    })
  })
})
