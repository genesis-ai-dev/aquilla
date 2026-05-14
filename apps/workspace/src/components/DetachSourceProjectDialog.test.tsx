import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { DetachSourceProjectDialog } from "./DetachSourceProjectDialog"

describe("DetachSourceProjectDialog", () => {
  it("renders the source project name in the warning text", () => {
    render(
      <DetachSourceProjectDialog
        open
        onOpenChange={() => {}}
        sourceProjectName="Hebrew OT"
        onConfirm={async () => null}
      />,
    )
    // Name appears in both the body and the inline em — at least one match.
    expect(screen.getAllByText(/Hebrew OT/).length).toBeGreaterThan(0)
  })

  it("calls onConfirm when the Detach button is clicked", async () => {
    const onConfirm = vi.fn(async () => ({
      projectId: "p1",
      previousSourceProjectId: "src-1",
      snapshottedCellCount: 12,
    }))
    render(
      <DetachSourceProjectDialog
        open
        onOpenChange={() => {}}
        sourceProjectName="Hebrew OT"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /detach/i }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
  })

  it("surfaces the snapshot count on success", async () => {
    const onConfirm = vi.fn(async () => ({
      projectId: "p1",
      previousSourceProjectId: "src-1",
      snapshottedCellCount: 31102,
    }))
    render(
      <DetachSourceProjectDialog
        open
        onOpenChange={() => {}}
        sourceProjectName="Hebrew OT"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /detach/i }))
    await waitFor(() => expect(screen.getByText(/31,102/)).toBeInTheDocument())
    expect(screen.getByText(/Detached\./i)).toBeInTheDocument()
  })

  it("shows the error message when provided and no success result", () => {
    render(
      <DetachSourceProjectDialog
        open
        onOpenChange={() => {}}
        sourceProjectName="Hebrew OT"
        error="Server rejected the detach request"
        onConfirm={async () => null}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent(/Server rejected/i)
  })

  it("falls back to 'the upstream project' when sourceProjectName is missing", () => {
    render(
      <DetachSourceProjectDialog
        open
        onOpenChange={() => {}}
        onConfirm={async () => null}
      />,
    )
    expect(screen.getAllByText(/the upstream project/).length).toBeGreaterThan(0)
  })
})
