import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { MirrorActions, MirrorState } from "@/lib/paratext-bridge/use-paratext-mirror"
import { ParatextBridgeBadge } from "./ParatextBridgeBadge"

const mirror = vi.hoisted(() => ({ state: null as unknown }))

vi.mock("@/lib/paratext-bridge/use-paratext-mirror", () => ({
  useParatextMirror: () => [mirror.state, {} as MirrorActions],
}))

function renderBadge(over: Partial<MirrorState>) {
  mirror.state = {
    link: { projectPath: "/pt/TPP1", projectGuid: "g", books: {} },
    book: { code: "MAT", fileName: "41MATTPP1.SFM" },
    busy: null, conflicts: [], refusals: [], onHold: false, unmapped: 0, pending: 0, error: null,
    ...over,
  } as MirrorState
  return render(<ParatextBridgeBadge projectId="p" fileId="f" lane="en" author="a" getToken={async () => "t"} />)
}

// A translator's edits live only in Aquilla until "Write to Paratext" runs.
// The header button is the one place that says so, so it must tell edits that
// are waiting apart from a file that is already in step with Paratext.
describe("ParatextBridgeBadge unsaved indicator", () => {
  it("marks the button when the file has edits Paratext does not hold", () => {
    renderBadge({ pending: 3 })
    expect(screen.getByTestId("paratext-unsaved-dot")).toBeTruthy()
    // The count is in the accessible name: the dot alone is invisible to a screen reader.
    expect(screen.getByRole("button", { name: /3 changes to write/ })).toBeTruthy()
  })

  it("shows no mark when everything is written", () => {
    renderBadge({ pending: 0 })
    expect(screen.queryByTestId("paratext-unsaved-dot")).toBeNull()
    expect(screen.getByRole("button", { name: /^Paratext bridge$/ })).toBeTruthy()
  })

  it("is an icon button with no text label, like the header's Settings cog", () => {
    renderBadge({ pending: 0 })
    const button = screen.getByTestId("paratext-badge")
    expect(button.textContent).toBe("")
  })

  it("renders nothing on a file that mirrors no Paratext book", () => {
    const { container } = renderBadge({ book: null })
    expect(container.innerHTML).toBe("")
  })
})
