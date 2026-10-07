import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConflictIndicator } from "./ConflictIndicator"
import { __resetConflictsForTests, getConflicts, markConflict } from "@/lib/offline/conflicts"

beforeEach(() => {
  __resetConflictsForTests()
})

afterEach(() => {
  __resetConflictsForTests()
})

describe("ConflictIndicator", () => {
  it("renders nothing when its cell isn't conflicted", () => {
    render(<ConflictIndicator cellRowKey="proj1:file1:GEN 1:1:target" />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders a badge only for the conflicted cell, not an unrelated one", () => {
    markConflict("proj1:file1:GEN 1:1:target")
    render(
      <>
        <ConflictIndicator cellRowKey="proj1:file1:GEN 1:1:target" />
        <ConflictIndicator cellRowKey="proj1:file1:GEN 1:2:target" />
      </>,
    )
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })

  it("dismisses only its own cell's conflict on click", async () => {
    const user = userEvent.setup()
    markConflict("proj1:file1:GEN 1:1:target")
    markConflict("proj1:file1:GEN 1:2:target")
    render(<ConflictIndicator cellRowKey="proj1:file1:GEN 1:1:target" />)

    await user.click(screen.getByRole("button"))

    expect(getConflicts().has("proj1:file1:GEN 1:1:target")).toBe(false)
    expect(getConflicts().has("proj1:file1:GEN 1:2:target")).toBe(true)
  })
})
