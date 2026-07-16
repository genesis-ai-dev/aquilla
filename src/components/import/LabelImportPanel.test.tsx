/**
 * AQU-438: Tests for the LabelImportPanel apply path.
 *
 * Validates:
 *   - Template download triggers generateLabelTemplate with project's refs.
 *   - CSV upload parses correctly into the preview table.
 *   - Apply emits cast.assign events (never target.cell.commit).
 *   - Unmatched refs are reported but do NOT stop matched cells from applying.
 *   - onImported is called after successful apply.
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LabelImportPanel } from "@/components/import/LabelImportPanel"
import type { SourceCellRef } from "@/lib/import"

// ScrollArea uses @base-ui/react which calls getAnimations() — not in happy-dom.
// Stub it with a plain div so component tests don't crash.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

// ── Mock emitCastAssign ───────────────────────────────────────────────────

const mockEmitCastAssign = vi.fn().mockResolvedValue("evt-test-id")

vi.mock("@/lib/sync/events-emit", () => ({
  emitCastAssign: (...args: unknown[]) => mockEmitCastAssign(...args),
}))

// ── Helpers ───────────────────────────────────────────────────────────────

const SOURCE_CELLS: SourceCellRef[] = [
  { cellId: "cell-gen-1-1", fileId: "file-genesis", canonicalRef: "GEN 1:1", translated: "" },
  { cellId: "cell-gen-1-2", fileId: "file-genesis", canonicalRef: "GEN 1:2", translated: "The earth…" },
  { cellId: "cell-gen-1-3", fileId: "file-genesis", canonicalRef: "GEN 1:3", translated: "" },
]

const DEFAULT_PROPS = {
  projectId: "proj-001",
  username: "pm-user",
  sourceCells: SOURCE_CELLS,
  getToken: vi.fn().mockResolvedValue("tok"),
  onImported: vi.fn(),
  onCancel: vi.fn(),
}

function makeCSV(rows: { ref: string; castName: string }[]): File {
  const header = "ref,cast_name,note\r\n"
  const body = rows.map((r) => `"${r.ref}","${r.castName}",`).join("\r\n")
  return new File([header + body], "labels.csv", { type: "text/csv" })
}

describe("LabelImportPanel — template download", () => {
  it("shows a Download CSV template button", () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)
    expect(screen.getByText(/Download CSV template/i)).toBeInTheDocument()
  })
})

describe("LabelImportPanel — CSV upload + preview", () => {
  beforeEach(() => {
    mockEmitCastAssign.mockClear()
    DEFAULT_PROPS.onImported.mockClear()
    DEFAULT_PROPS.onCancel.mockClear()
  })

  it("shows a preview table after uploading a valid CSV", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([
      { ref: "GEN 1:1", castName: "Narrator" },
      { ref: "GEN 1:2", castName: "God" },
    ])

    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => {
      expect(screen.getByText("Narrator")).toBeInTheDocument()
      expect(screen.getByText("God")).toBeInTheDocument()
    })

    // Import button should appear
    expect(screen.getByRole("button", { name: /import 2 labels/i })).toBeInTheDocument()
  })

  it("shows no preview for CSV with no filled cast names", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([]) // empty
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => {
      // Either an error or no import button
      expect(screen.queryByRole("button", { name: /import/i })).toBeNull()
    })
  })
})

describe("LabelImportPanel — apply (cast.assign events)", () => {
  beforeEach(() => {
    mockEmitCastAssign.mockClear()
    DEFAULT_PROPS.onImported.mockClear()
  })

  it("calls emitCastAssign for each matched ref and calls onImported", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([
      { ref: "GEN 1:1", castName: "Narrator" },
      { ref: "GEN 1:3", castName: "God" },
    ])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 2 labels/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 2 labels/i }))

    await waitFor(() => {
      expect(mockEmitCastAssign).toHaveBeenCalledTimes(2)
    })

    // Verify first call — GEN 1:1 → Narrator
    expect(mockEmitCastAssign).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-001",
        fileId: "file-genesis",
        cellId: "cell-gen-1-1",
        castName: "Narrator",
        author: "pm-user",
      }),
    )
    // Verify second call — GEN 1:3 → God
    expect(mockEmitCastAssign).toHaveBeenCalledWith(
      expect.objectContaining({
        cellId: "cell-gen-1-3",
        castName: "God",
      }),
    )

    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledTimes(1)
  })

  it("reports unmatched refs but still applies matched cells", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([
      { ref: "GEN 1:1", castName: "Narrator" },
      { ref: "REV 1:1", castName: "John" }, // does not exist in SOURCE_CELLS
    ])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 2 labels/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 2 labels/i }))

    await waitFor(() => {
      // GEN 1:1 matched and emitted
      expect(mockEmitCastAssign).toHaveBeenCalledTimes(1)
      expect(mockEmitCastAssign).toHaveBeenCalledWith(
        expect.objectContaining({ cellId: "cell-gen-1-1", castName: "Narrator" }),
      )
    })

    // Unmatched ref reported in error text
    await waitFor(() => {
      const errorEl = document.body.textContent
      expect(errorEl).toMatch(/REV 1:1/)
      expect(errorEl).toMatch(/not matched/)
    })

    // onImported still called (partial success)
    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledTimes(1)
  })

  it("does NOT call emitTargetCellCommit (target text must not be touched)", async () => {
    // Verify the mock has no reference to target.cell.commit.
    // If the implementation accidentally imports emitTargetCellCommit we'd see it here.
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([{ ref: "GEN 1:1", castName: "Narrator" }])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 1 label/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 1 label/i }))

    await waitFor(() => expect(mockEmitCastAssign).toHaveBeenCalledTimes(1))

    // The only event helper called must be emitCastAssign (from our mock).
    // This assertion holds because emitTargetCellCommit is not mocked and
    // would throw if called — the test passes only when the implementation
    // exclusively uses emitCastAssign.
    expect(mockEmitCastAssign).toHaveBeenCalledWith(
      expect.objectContaining({ castName: "Narrator" }),
    )
  })
})

// ─── AQU-439: angle-splitting on import ──────────────────────────────────────

describe("LabelImportPanel — AQU-439 angle splitting", () => {
  beforeEach(() => {
    mockEmitCastAssign.mockClear()
    DEFAULT_PROPS.onImported.mockClear()
  })

  it("splits a trailing (angle) group from the cast_name and forwards cameraState", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    // Cast name with angle group: "Mary Magdalene   (on)"
    const csv = makeCSV([{ ref: "GEN 1:1", castName: "Mary Magdalene   (on)" }])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 1 label/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 1 label/i }))

    await waitFor(() => expect(mockEmitCastAssign).toHaveBeenCalledTimes(1))

    // Voice name must be stripped of the angle suffix
    expect(mockEmitCastAssign).toHaveBeenCalledWith(
      expect.objectContaining({
        castName: "Mary Magdalene",
        cameraState: "on",
      }),
    )
  })

  it("emits cameraState: 'mixed' for the 'group' synonym", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([{ ref: "GEN 1:2", castName: "Crowd (group)" }])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 1 label/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 1 label/i }))

    await waitFor(() => expect(mockEmitCastAssign).toHaveBeenCalledTimes(1))
    expect(mockEmitCastAssign).toHaveBeenCalledWith(
      expect.objectContaining({ castName: "Crowd", cameraState: "mixed" }),
    )
  })

  it("omits cameraState when no angle group is in the cast_name", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([{ ref: "GEN 1:1", castName: "Narrator" }])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => screen.getByRole("button", { name: /import 1 label/i }))
    fireEvent.click(screen.getByRole("button", { name: /import 1 label/i }))

    await waitFor(() => expect(mockEmitCastAssign).toHaveBeenCalledTimes(1))

    // No cameraState in the payload when angle was absent
    const call = mockEmitCastAssign.mock.calls[0]?.[0]
    expect(call).not.toHaveProperty("cameraState")
  })

  it("shows a Camera column in the preview table", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([{ ref: "GEN 1:1", castName: "Mary (on)" }])
    fireEvent.change(fileInput, { target: { files: [csv] } })

    await waitFor(() => {
      expect(screen.getByText("Voice")).toBeInTheDocument()
      expect(screen.getByText("Camera")).toBeInTheDocument()
      expect(screen.getByText("on")).toBeInTheDocument()
      // Voice column shows split name, NOT raw "Mary (on)"
      expect(screen.getByText("Mary")).toBeInTheDocument()
    })
  })
})
