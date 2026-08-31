import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Dialog, DialogContent, DialogTitle } from "./dialog"

function overlays() {
  return document.querySelectorAll('[data-slot="dialog-overlay"]')
}

describe("Dialog overlay", () => {
  it("renders a backdrop behind a top-level dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument()
    expect(overlays()).toHaveLength(1)
    expect(overlays()[0]).not.toHaveAttribute("hidden")
  })

  it("renders a backdrop behind a nested dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Add a member</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByRole("dialog", { name: "Add a member" })).toBeInTheDocument()
    expect(overlays()).toHaveLength(2)
    for (const overlay of overlays()) {
      expect(overlay).not.toHaveAttribute("hidden")
    }
  })
})
