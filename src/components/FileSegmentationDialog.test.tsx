/**
 * FileSegmentationDialog — the file row's Segmentation menu.
 *
 * WHY these tests: the preview is the whole point of the dialog. A translator
 * approves a division by looking at it, so the numbers shown must come from
 * the server's resolver (the same one the autopilot run calls) and never be
 * recomputed here. These pin that the dialog renders what the server said,
 * that the save floor is enforced in the UI as well as the route, and that the
 * AI option is visible but not selectable until the pass behind it exists.
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { FileSegmentationDialog } from "./FileSegmentationDialog"
import type { SegmentationSnapshot } from "@/lib/contextual/segmentation-api"

const fetchSegmentation = vi.fn()
const saveSegmentation = vi.fn()

vi.mock("@/lib/contextual/segmentation-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contextual/segmentation-api")>()),
  fetchSegmentation: (...args: unknown[]) => fetchSegmentation(...args),
  saveSegmentation: (...args: unknown[]) => saveSegmentation(...args),
}))

function snapshot(over: Partial<SegmentationSnapshot> = {}): SegmentationSnapshot {
  return {
    segmentation: null,
    limits: { minSize: 2, maxSize: 50, maxBoundaries: 2000 },
    effective: {
      seedSource: "canonical-ref",
      spanCount: 2,
      cellCount: 14,
      spans: [
        { startCellId: "c1", endCellId: "c8", seedSource: "canonical-ref", cellCount: 8, label: "MRK 1:1–1:8" },
        { startCellId: "c9", endCellId: "c14", seedSource: "canonical-ref", cellCount: 6, label: "MRK 2:1–2:6" },
      ],
      truncated: false,
    },
    available: true,
    ...over,
  }
}

function renderDialog(over: Partial<Parameters<typeof FileSegmentationDialog>[0]> = {}) {
  return render(
    <I18nProvider>
      <FileSegmentationDialog
        projectId="p1"
        fileId="f1"
        fileName="Mark"
        open
        onOpenChange={vi.fn()}
        canEdit
        {...over}
      />
    </I18nProvider>,
  )
}

beforeEach(() => {
  fetchSegmentation.mockReset().mockResolvedValue(snapshot())
  saveSegmentation.mockReset().mockResolvedValue({})
})

describe("FileSegmentationDialog", () => {
  it("renders the server's span count and preview labels verbatim", async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/2 passages across 14 segments/)).toBeTruthy())
    expect(screen.getByText("MRK 1:1–1:8")).toBeTruthy()
    expect(screen.getByText("MRK 2:1–2:6")).toBeTruthy()
    expect(fetchSegmentation).toHaveBeenCalledWith("p1", "f1")
  })

  it("names the stored strategy when one is set", async () => {
    fetchSegmentation.mockResolvedValue(
      snapshot({
        segmentation: {
          projectId: "p1", fileId: "f1", strategy: "fixed", fixedSize: 6, boundaries: null,
          note: null, generatedBy: "human", modelId: null, humanEdited: true,
          staleSince: null, staleReason: null, version: 1, updatedBy: "lead",
          createdAt: "", updatedAt: "",
        },
      }),
    )
    renderDialog()
    await waitFor(() => expect(screen.getByText(/Every 6 segments/)).toBeTruthy())
  })

  it("warns when the saved passages went stale under a source edit", async () => {
    fetchSegmentation.mockResolvedValue(
      snapshot({
        segmentation: {
          projectId: "p1", fileId: "f1", strategy: "explicit", fixedSize: null,
          boundaries: [{ startCellId: "c1", endCellId: "c14" }],
          note: null, generatedBy: "model", modelId: "m/1", humanEdited: false,
          staleSince: "2026-08-01T00:00:00Z", staleReason: "source-edit",
          version: 2, updatedBy: null, createdAt: "", updatedAt: "",
        },
      }),
    )
    renderDialog()
    await waitFor(() => expect(screen.getByText(/source has changed/i)).toBeTruthy())
    expect(screen.getByText(/saved passage list/i)).toBeTruthy()
  })

  it("saves a fixed size the lead typed", async () => {
    const onOpenChange = vi.fn()
    renderDialog({ onOpenChange })
    await waitFor(() => expect(screen.getByText(/Divide this file/i)).toBeTruthy())

    await userEvent.click(screen.getByRole("radio", { name: /Every N segments/i }))
    const input = await screen.findByLabelText(/Segments per passage/i)
    await userEvent.clear(input)
    await userEvent.type(input, "6")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(saveSegmentation).toHaveBeenCalledWith("p1", "f1", { strategy: "fixed", fixedSize: 6 }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("refuses to save a size outside the server's bounds", async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/Divide this file/i)).toBeTruthy())
    await userEvent.click(screen.getByRole("radio", { name: /Every N segments/i }))
    const input = await screen.findByLabelText(/Segments per passage/i)
    await userEvent.clear(input)
    await userEvent.type(input, "999")
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
    expect(saveSegmentation).not.toHaveBeenCalled()
  })

  it("offers the AI option but cannot select it — the pass behind it does not exist yet", async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(/Let AI find the passages/i)).toBeTruthy())
    const ai = screen.getByRole("radio", { name: /Let AI find the passages/i })
    expect(ai.hasAttribute("disabled") || ai.getAttribute("aria-disabled") === "true").toBe(true)
    expect(screen.getByText(/Not available yet/i)).toBeTruthy()
  })

  it("reads but cannot save below Project Lead", async () => {
    renderDialog({ canEdit: false })
    await waitFor(() => expect(screen.getByText(/2 passages across 14 segments/)).toBeTruthy())
    expect(screen.getByText(/requires the Project Lead role/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
  })

  it("explains itself when the server does not serve the route", async () => {
    fetchSegmentation.mockResolvedValue(snapshot({ available: false }))
    renderDialog()
    await waitFor(() => expect(screen.getByText(/not available on this server/i)).toBeTruthy())
    expect(screen.queryByText(/Divide this file/i)).toBeNull()
  })

  it("surfaces a save failure instead of closing", async () => {
    const onOpenChange = vi.fn()
    saveSegmentation.mockRejectedValue(new Error("boundaries leave a gap of 3 cell(s)"))
    renderDialog({ onOpenChange })
    await waitFor(() => expect(screen.getByText(/Divide this file/i)).toBeTruthy())
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.getByText(/gap of 3 cell/)).toBeTruthy())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
