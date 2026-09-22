import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConflictToast } from "./ConflictToast"
import { Toaster, toast } from "@/components/ui/toast"
import { __resetConflictsForTests, dismissConflict, getConflicts, markConflict } from "@/lib/offline/conflicts"

beforeEach(() => {
  __resetConflictsForTests()
})

afterEach(() => {
  toast.close()
  __resetConflictsForTests()
})

function renderConflictToast() {
  return render(
    <>
      <Toaster />
      <ConflictToast />
    </>,
  )
}

describe("ConflictToast", () => {
  it("shows nothing while there are no conflicts", () => {
    renderConflictToast()
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it("shows one summary toast (not one per cell) once conflicts are marked", async () => {
    renderConflictToast()
    markConflict("proj1:file1:GEN 1:1:target")
    markConflict("proj1:file1:GEN 1:2:target")

    expect(await screen.findByText(/2 translations couldn't sync/)).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1)
  })

  it("Dismiss clears every tracked conflict and closes the toast", async () => {
    const user = userEvent.setup()
    renderConflictToast()
    markConflict("proj1:file1:GEN 1:1:target")

    await screen.findByText(/1 translation couldn't sync/)
    await user.click(screen.getByRole("button", { name: /dismiss/i }))

    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).toBeNull())
    expect(getConflicts().size).toBe(0)
  })

  it("closes the toast once the conflict set drains back to empty on its own (not via Dismiss)", async () => {
    renderConflictToast()
    markConflict("proj1:file1:GEN 1:1:target")
    await screen.findByText(/1 translation couldn't sync/)

    dismissConflict("proj1:file1:GEN 1:1:target")
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).toBeNull())
  })
})
