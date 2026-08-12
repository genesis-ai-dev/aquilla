// Reference typography — WHY: this panel shows the same canonical ref twice, as
// the badge beside its heading and inside the "no notes" message. The badge is
// monospaced because a ref is machine-readable data; when the empty-state
// sentence became one catalog key the ref in it was interpolated as bare prose,
// so one UI rendered the same value two different ways.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

const fetchProjectFiles = vi.fn()
const fetchFileCells = vi.fn()
vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: (...args: unknown[]) => fetchProjectFiles(...args),
  fetchFileCells: (...args: unknown[]) => fetchFileCells(...args),
}))

import { TranslationNotesSidebar } from "./TranslationNotesSidebar"

describe("TranslationNotesSidebar empty state", () => {
  beforeEach(() => {
    fetchProjectFiles.mockReset()
    fetchFileCells.mockReset()
  })

  it("monospaces the reference in the empty-state sentence, as the header badge does", async () => {
    fetchProjectFiles.mockResolvedValue([])
    render(
      <TranslationNotesSidebar
        projectId="proj-1"
        canonicalRef="GEN 1:1"
        getToken={async () => "tok"}
        visible={true}
        onToggle={() => {}}
      />,
    )

    // Both renderings of the ref, header badge first.
    await waitFor(() => expect(screen.getAllByText("GEN 1:1")).toHaveLength(2))
    const rendered = screen.getAllByText("GEN 1:1")
    // Assert the class on each element rather than the sentence text: "No
    // translation notes for GEN 1:1." reads identically once the markup is gone,
    // which is exactly why the flattening went unnoticed.
    for (const el of rendered) expect(el).toHaveClass("font-mono")
    const sentence = rendered[1].parentElement
    expect(sentence?.textContent).toBe("No translation notes for GEN 1:1.")
  })
})
