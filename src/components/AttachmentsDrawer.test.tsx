/**
 * AQU-777 — the attachments drawer.
 *
 * UI-level coverage per AGENTS.md ("UI chrome belongs in Vitest/RTL"): the
 * grouping contract the issue's checklist spells out (grouped by cell, in cell
 * order, and a cell with no attachments never appears as an empty group), the
 * remove gate, and the empty/loading/error states.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AttachmentsDrawer } from "./AttachmentsDrawer"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"
import type { FrontierSession } from "@/lib/frontier/types"

// The drawer mints an authenticated `?t=` URL per previewable attachment;
// stub the token fetcher so the preview resolves synchronously enough to
// assert on, without touching the network.
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "test-token",
}))

const session = { jwt: "jwt", username: "ana" } as unknown as FrontierSession

function makeRecord(overrides: Partial<CellAttachmentRecord> = {}): CellAttachmentRecord {
  return {
    attachmentId: "att-1",
    projectId: "proj-1",
    fileId: "file-1",
    cellId: "GEN 1:1",
    objectName: "att-1.png",
    name: "layout.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    authorId: "ana",
    authorLabel: "ana",
    createdAt: 1000,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

function renderDrawer(props: Partial<React.ComponentProps<typeof AttachmentsDrawer>> = {}) {
  return render(
    <AttachmentsDrawer
      projectId="proj-1"
      fileId="file-1"
      session={session}
      attachments={[makeRecord()]}
      isLoading={false}
      isError={false}
      truncated={false}
      focusAttachmentId={null}
      onRemove={null}
      onClose={() => {}}
      {...props}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("AttachmentsDrawer", () => {
  it("groups attachments by cell, in cell order", () => {
    renderDrawer({
      attachments: [
        makeRecord({ attachmentId: "a1", cellId: "GEN 1:1", cellRef: "GEN 1:1", name: "one.png" }),
        makeRecord({ attachmentId: "a2", cellId: "GEN 1:1", cellRef: "GEN 1:1", name: "two.png" }),
        makeRecord({ attachmentId: "a3", cellId: "GEN 1:2", cellRef: "GEN 1:2", name: "three.png" }),
      ],
    })

    const groups = screen.getAllByRole("region")
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveAccessibleName("GEN 1:1")
    expect(groups[1]).toHaveAccessibleName("GEN 1:2")
    // Both of the first cell's attachments sit inside its own group.
    expect(groups[0]).toHaveTextContent("one.png")
    expect(groups[0]).toHaveTextContent("two.png")
    expect(groups[0]).not.toHaveTextContent("three.png")
  })

  it("never renders a group for a cell with no attachments", () => {
    // The list is built FROM the attachments, so an empty group is not
    // something to filter out — it cannot be constructed at all.
    renderDrawer({ attachments: [makeRecord({ cellId: "GEN 1:5", cellRef: "GEN 1:5" })] })
    expect(screen.getAllByRole("region")).toHaveLength(1)
  })

  it("falls back to a stand-in label when the cell has no canonical ref", () => {
    renderDrawer({ attachments: [makeRecord({ cellRef: null, cellId: "cell-xyz" })] })
    expect(screen.getByRole("region")).toHaveAccessibleName("cell-xyz")
    expect(screen.getByText(/Unlabelled cell/i)).toBeInTheDocument()
  })

  it("takes a group's label from whichever row carries one", () => {
    // The cellRef LEFT JOIN can leave the column null on some rows of a cell.
    renderDrawer({
      attachments: [
        makeRecord({ attachmentId: "a1", cellRef: null }),
        makeRecord({ attachmentId: "a2", cellRef: "GEN 1:1" }),
      ],
    })
    expect(screen.getByRole("region")).toHaveAccessibleName("GEN 1:1")
  })

  it("highlights the attachment that was clicked", () => {
    const { container } = renderDrawer({
      attachments: [
        makeRecord({ attachmentId: "a1" }),
        makeRecord({ attachmentId: "a2", cellId: "GEN 1:2" }),
      ],
      focusAttachmentId: "a2",
    })
    expect(container.querySelector('[data-attachment-id="a2"]')).toHaveAttribute(
      "data-focused",
      "true",
    )
    expect(container.querySelector('[data-attachment-id="a1"]')).not.toHaveAttribute("data-focused")
  })

  it("previews an image inline and offers a full-size link", async () => {
    renderDrawer()
    const img = await screen.findByRole("img")
    expect(img).toHaveAttribute("src", expect.stringContaining("t=test-token"))
    expect(await screen.findByRole("link")).toHaveAttribute("target", "_blank")
  })

  it("shows a PDF as an icon row, not a broken <img>", async () => {
    renderDrawer({
      attachments: [makeRecord({ mimeType: "application/pdf", name: "notes.pdf" })],
    })
    expect(screen.getByText("notes.pdf")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument())
  })

  it("hides the remove button when the viewer may not remove", () => {
    // Null rather than a disabled button: a viewer should see the previews
    // without a control that would 403.
    renderDrawer({ onRemove: null })
    expect(screen.queryByRole("button", { name: /remove attachment/i })).not.toBeInTheDocument()
  })

  it("calls back with the attachment when remove is clicked", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    renderDrawer({ onRemove })
    await userEvent.click(screen.getByRole("button", { name: /remove attachment/i }))
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: "att-1" }))
  })

  it("surfaces a failed removal instead of swallowing it", async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error("offline"))
    renderDrawer({ onRemove })
    await userEvent.click(screen.getByRole("button", { name: /remove attachment/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
  })

  it("highlights nothing when the focused id is not in the list", () => {
    // Happens on a file switch with the panel open: the panel is file-scoped,
    // so it stays open and shows the NEW file's attachments — but the id the
    // user clicked belonged to the file they left. Nothing is highlighted and
    // nothing is scrolled to; the panel must not blank out or throw.
    const { container } = renderDrawer({
      attachments: [makeRecord({ attachmentId: "a1" })],
      focusAttachmentId: "from-the-previous-file",
    })
    expect(container.querySelector("[data-focused]")).toBeNull()
    expect(screen.getByText("layout.png")).toBeInTheDocument()
  })

  it("shows an empty state when the file has no attachments", () => {
    renderDrawer({ attachments: [] })
    expect(screen.getByText(/No attachments in this file yet/i)).toBeInTheDocument()
  })

  it("distinguishes a load error from an empty file", () => {
    // AQU-1275's lesson on the comments drawer: a fetch failure rendered as
    // "nothing here" makes data look lost.
    renderDrawer({ attachments: [], isError: true })
    expect(screen.getByText(/Couldn't load attachments/i)).toBeInTheDocument()
    expect(screen.queryByText(/No attachments in this file yet/i)).not.toBeInTheDocument()
  })

  it("says so when the list is truncated", () => {
    renderDrawer({ truncated: true })
    expect(screen.getByText(/Showing the first/i)).toBeInTheDocument()
  })
})
