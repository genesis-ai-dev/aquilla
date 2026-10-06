// AQU-1693: the "Bible person, place or group" section of the term detail page.
// Why: only someone at the termbase floor may change a link (the server gates
// term.update there), so others must see the link but no controls; and a pack
// that cannot be reached must say so, not look like a book with no people.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { Concept } from "@/lib/terminology/types"
import { JESUS, jhn4People } from "@/lib/bible-data/__fixtures__/jhn4"

const loadManifest = vi.fn()
const loadLayer = vi.fn()
vi.mock("@/lib/bible-data/pack-client", () => ({
  loadManifest: () => loadManifest(),
  loadLayer: (layer: string, book: string) => loadLayer(layer, book),
}))

import { BibleEntityLinkSection } from "./BibleEntityLinkSection"

const jesus: Concept = {
  id: "c1",
  sourceTerm: "Jesus",
  renderings: [{ rendering: "Yesus", status: "preferred" }],
  status: "active",
  createdAt: "2026-10-06T00:00:00.000Z",
}

function renderSection(concept: Concept, canEdit: boolean) {
  return render(
    <I18nProvider>
      <BibleEntityLinkSection concept={concept} canEdit={canEdit} defaultBook="JHN" onChange={vi.fn()} />
    </I18nProvider>,
  )
}

beforeEach(() => {
  loadManifest.mockReset().mockResolvedValue({ ok: true, value: { books: { JHN: { layers: ["people"], bytes: {} } } } })
  loadLayer.mockReset().mockResolvedValue({ ok: true, value: jhn4People() })
})

describe("BibleEntityLinkSection", () => {
  it("shows a link to someone below the termbase floor, without Change or Unlink", async () => {
    renderSection({ ...jesus, externalIds: { acai: JESUS } }, false)
    expect(await screen.findByText(/Linked to .*Jesus/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull()
  })

  it("shows nothing to someone below the floor when there is no link, and reads no pack", () => {
    const { container } = renderSection(jesus, false)
    expect(container).toBeEmptyDOMElement()
    expect(loadManifest).not.toHaveBeenCalled()
  })

  it("says the Bible data did not load instead of showing an empty list", async () => {
    loadLayer.mockResolvedValue({ ok: false, reason: "offline" })
    renderSection(jesus, true)
    fireEvent.click(screen.getByRole("button", { name: "Link to a Bible person, place or group" }))
    expect(await screen.findByText("Bible data did not load. Try again when you are online.")).toBeInTheDocument()
    expect(screen.queryByText("No person, place or group in this book matches.")).toBeNull()
  })
})
