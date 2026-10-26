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

describe("toast button row (AQU-2175)", () => {
  const rowOf = (el: HTMLElement) => el.closest("[data-slot='toast-actions']")

  it("puts the buttons on their own row below the message, not beside it", async () => {
    render(<Toaster />)
    act(() => {
      toast.add({
        type: "info",
        timeout: 0,
        title: "Zero-shot needs at least one recorded and transcribed line in this language.",
        actionProps: { children: "Use Omnilingual standard instead", onClick: () => {} },
        data: { secondaryAction: { label: "Use automatic", onClick: () => {} } },
      })
    })
    const message = await screen.findByText(
      "Zero-shot needs at least one recorded and transcribed line in this language.",
    )
    const primary = screen.getByRole("button", { name: "Use Omnilingual standard instead" })
    const secondary = screen.getByRole("button", { name: "Use automatic" })

    // Both buttons share one row, and that row does not contain the message —
    // which is what used to squeeze it into a one-word column.
    const row = rowOf(primary)
    expect(row).not.toBeNull()
    expect(rowOf(secondary)).toBe(row)
    expect(row).not.toContainElement(message)

    // The close X stays out of the button row, in the message row.
    const close = screen.getByLabelText("Close toast")
    expect(rowOf(close)).toBeNull()
  })

  it("renders no button row for a toast without buttons", async () => {
    render(<Toaster />)
    act(() => {
      toast.add({ type: "info", timeout: 0, title: "Your organization has turned off zero-shot transcription." })
    })
    const message = await screen.findByText(
      "Your organization has turned off zero-shot transcription.",
    )
    const content = message.closest("[data-slot='toast-content']") as HTMLElement
    expect(content.querySelector("[data-slot='toast-actions']")).toBeNull()
  })
})

describe("toast pulse (AQU-2125)", () => {
  const pulseOf = (title: string) =>
    screen.getByText(title).closest("[data-slot='toast-pulse']") as HTMLElement

  it("stays still while an update reports progress", async () => {
    render(<Toaster />)
    let id = ""
    act(() => {
      id = toast.add({ type: "loading", title: "Assigning characters — 0 of 30…", timeout: 0 })
    })
    await screen.findByText("Assigning characters — 0 of 30…")
    act(() => {
      toast.update(id, { type: "loading", title: "Assigning characters — 10 of 30…" })
    })
    expect(pulseOf("Assigning characters — 10 of 30…")).not.toHaveAttribute("data-pulsing")
    act(() => {
      toast.update(id, { type: "success", title: "30 lines now carry a character" })
    })
    expect(pulseOf("30 lines now carry a character")).not.toHaveAttribute("data-pulsing")
  })

  it("still pulses when the same toast is raised again", async () => {
    render(<Toaster />)
    act(() => {
      toast.add({ type: "success", title: "Copied the line" })
    })
    await screen.findByText("Copied the line")
    act(() => {
      toast.add({ type: "success", title: "Copied the line" })
    })
    expect(pulseOf("Copied the line")).toHaveAttribute("data-pulsing")
  })
})
