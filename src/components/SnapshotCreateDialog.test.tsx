// SnapshotCreateDialog component tests (FRO-176).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SnapshotCreateDialog } from "./SnapshotCreateDialog"
import type { Snapshot } from "@/hooks/useSnapshots"

const SAMPLE_SNAP: Snapshot = {
  id: "snap-1",
  projectId: "proj-1",
  name: "v1 release",
  description: null,
  createdBy: "alice",
  snapshotTs: 1700000000000,
  createdAt: "2023-11-14T00:00:00Z",
}

describe("SnapshotCreateDialog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onCreateMock: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onOpenChangeMock: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onCreatedMock: any

  let onCreate: (name: string, description?: string) => Promise<Snapshot>
  let onOpenChange: (open: boolean) => void
  let onCreated: (snapshot: Snapshot) => void

  beforeEach(() => {
    onCreateMock = vi.fn().mockResolvedValue(SAMPLE_SNAP)
    onOpenChangeMock = vi.fn()
    onCreatedMock = vi.fn()
    onCreate = onCreateMock as typeof onCreate
    onOpenChange = onOpenChangeMock as typeof onOpenChange
    onCreated = onCreatedMock as typeof onCreated
  })

  it("renders name and description fields when open", () => {
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    )
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument()
  })

  it("disables submit button when name is empty", () => {
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    )
    const submitBtn = screen.getByRole("button", { name: /create snapshot/i })
    expect(submitBtn).toBeDisabled()
  })

  it("enables submit button when name is filled", async () => {
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    )
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "My snap" } })
    const submitBtn = screen.getByRole("button", { name: /create snapshot/i })
    expect(submitBtn).not.toBeDisabled()
  })

  it("calls onCreate with name and description on submit", async () => {
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    )
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "v1 release" } })
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "A note" } })
    fireEvent.click(screen.getByRole("button", { name: /create snapshot/i }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("v1 release", "A note"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(SAMPLE_SNAP))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("shows an error message when onCreate rejects", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    onCreateMock.mockRejectedValue(new Error("server error"))
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    )
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "bad snap" } })
    fireEvent.click(screen.getByRole("button", { name: /create snapshot/i }))

    await waitFor(() =>
      expect(screen.getByText(/failed to create snapshot/i)).toBeInTheDocument(),
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("closes without calling onCreate when Cancel is clicked", () => {
    render(
      <SnapshotCreateDialog
        open={true}
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCreate).not.toHaveBeenCalled()
  })
})
