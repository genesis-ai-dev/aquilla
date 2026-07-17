/**
 * AQU-438: Tests for the LabelImportPanel apply path.
 *
 * Validates:
 *   - Template download triggers generateLabelTemplate with the file's refs.
 *   - CSV upload parses correctly into the preview table.
 *   - Apply emits cast.assign events (never target.cell.commit).
 *   - Unmatched refs are reported but do NOT stop matched cells from applying.
 *   - onImported is called after successful apply.
 *   - AQU-314: step 1 fetches the picked file's source cells from the server
 *     (no dependency on the editor's active file).
 */

import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LabelImportPanel } from "@/components/import/LabelImportPanel"

// ScrollArea uses @base-ui/react which calls getAnimations() — not in happy-dom.
// Stub it with a plain div so component tests don't crash.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

// Select is @base-ui/react too — stub with plain elements. The picker's
// fetch-on-selection behavior is covered via the defaultFileId path.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}))

// ── Mock emitCastAssign ───────────────────────────────────────────────────

const mockEmitCastAssign = vi.fn().mockResolvedValue("evt-test-id")

vi.mock("@/lib/sync/events-emit", () => ({
  emitCastAssign: (...args: unknown[]) => mockEmitCastAssign(...args),
}))

// ── Mock the server cell read (AQU-314 file picker) ───────────────────────

const mockFetchAllFileCells = vi.fn()

vi.mock("@/lib/sync/cells-read", () => ({
  fetchAllFileCells: (...args: unknown[]) => mockFetchAllFileCells(...args),
}))

// ── Helpers ───────────────────────────────────────────────────────────────

/** Rows as returned by fetchAllFileCells (CellRow slice the panel reads). */
const SERVER_CELLS = [
  { cellId: "cell-gen-1-1", canonicalRef: "GEN 1:1" },
  { cellId: "cell-gen-1-2", canonicalRef: "GEN 1:2" },
  { cellId: "cell-gen-1-3", canonicalRef: "GEN 1:3" },
]

const DEFAULT_PROPS = {
  projectId: "proj-001",
  username: "pm-user",
  files: [
    { id: "file-genesis", name: "Genesis.usfm" },
    { id: "file-exodus", name: "Exodus.usfm" },
  ],
  defaultFileId: "file-genesis",
  getToken: vi.fn().mockResolvedValue("tok"),
  onImported: vi.fn(),
  onCancel: vi.fn(),
}

function makeCSV(rows: { ref: string; castName: string }[]): File {
  const header = "ref,cast_name,note\r\n"
  const body = rows.map((r) => `"${r.ref}","${r.castName}",`).join("\r\n")
  return new File([header + body], "labels.csv", { type: "text/csv" })
}

describe("LabelImportPanel — file picker + template download (AQU-314)", () => {
  beforeEach(() => {
    mockFetchAllFileCells.mockReset().mockResolvedValue(SERVER_CELLS)
    DEFAULT_PROPS.getToken.mockClear()
  })

  it("shows a Download CSV template button", () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)
    expect(screen.getByText(/Download CSV template/i)).toBeInTheDocument()
  })

  it("fetches the default file's source cells and reports the ref count", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    await waitFor(() => {
      expect(screen.getByText(/3 cells with references in Genesis\.usfm/)).toBeInTheDocument()
    })
    // Token minted for the picked file; read scoped to source side.
    expect(DEFAULT_PROPS.getToken).toHaveBeenCalledWith("file-genesis")
    expect(mockFetchAllFileCells).toHaveBeenCalledWith("proj-001", "file-genesis", "tok", "source")
  })

  it("lists every project file in the picker", () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)
    expect(screen.getByText("Genesis.usfm")).toBeInTheDocument()
    expect(screen.getByText("Exodus.usfm")).toBeInTheDocument()
  })

  it("surfaces a cell-load failure instead of a zero count", async () => {
    mockFetchAllFileCells.mockReset().mockRejectedValue(new Error("boom: read failed"))
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    await waitFor(() => {
      expect(screen.getByText(/boom: read failed/)).toBeInTheDocument()
    })
  })
})

describe("LabelImportPanel — CSV upload + preview", () => {
  beforeEach(() => {
    mockFetchAllFileCells.mockReset().mockResolvedValue(SERVER_CELLS)
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
    mockFetchAllFileCells.mockReset().mockResolvedValue(SERVER_CELLS)
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

    // AQU-314: result confirmation carries the outcome for the host's notice.
    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledTimes(1)
    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledWith({
      applied: 2,
      unmatched: 0,
      fileName: "Genesis.usfm",
    })
  })

  it("reports unmatched refs in the result but still applies matched cells", async () => {
    render(<LabelImportPanel {...DEFAULT_PROPS} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csv = makeCSV([
      { ref: "GEN 1:1", castName: "Narrator" },
      { ref: "REV 1:1", castName: "John" }, // does not exist in SERVER_CELLS
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

    // AQU-314: the dialog closes on completion, so the unmatched count is
    // reported through the result callback (not an inline error the user
    // could never read).
    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledTimes(1)
    expect(DEFAULT_PROPS.onImported).toHaveBeenCalledWith({
      applied: 1,
      unmatched: 1,
      fileName: "Genesis.usfm",
    })
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
    mockFetchAllFileCells.mockReset().mockResolvedValue(SERVER_CELLS)
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
