import { describe, it, expect, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Toaster, toast } from "./toast"

describe("toast dedupe", () => {
  it("upserts identical content instead of allocating a new id", () => {
    const first = toast.add({ type: "success", title: "Email copied to clipboard" })
    const second = toast.add({ type: "success", title: "Email copied to clipboard" })
    expect(second).toBe(first)
  })

  it("keeps distinct messages on distinct ids", () => {
    const a = toast.add({ type: "success", title: "Validated 1 cell" })
    const b = toast.add({ type: "success", title: "Validated 2 cells" })
    expect(b).not.toBe(a)
  })

  it("honors an explicit id for status-style upserts", () => {
    const first = toast.add({ id: "save-status", title: "Draft saved" })
    const second = toast.add({
      id: "save-status",
      title: "Draft saved",
      description: "Still the same toast.",
    })
    expect(second).toBe(first)
    expect(first).toBe("save-status")
  })
})

describe("toast secondary action (AQU-1486)", () => {
  it("renders data.secondaryAction beside the primary action, runs it, and closes the toast", async () => {
    render(<Toaster />)
    const validateAll = vi.fn()
    const undo = vi.fn()
    act(() => {
      toast.add({
        title: "Applied to 2 repeated segments",
        actionProps: { children: "Undo", onClick: undo },
        data: { secondaryAction: { label: "Validate all", onClick: validateAll } },
      })
    })
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Validate all" }))
    expect(validateAll).toHaveBeenCalledTimes(1)
    expect(undo).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText("Applied to 2 repeated segments")).toBeNull())
  })
})
