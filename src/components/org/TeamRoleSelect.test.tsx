// AQU-1352 P2 (spec §3.1, §3.4): the per-member team role on TeamDetail.
// A team maintainer may manage roles but never grant above their own level
// (the server rejects it; the picker should not offer it), and callers who
// cannot edit see the role read-only rather than a dead control.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TeamRoleSelect } from "./TeamRoleSelect"

// Same Base UI select interaction as TeamDetail.test.tsx pickSelectOption.
async function pick(name: string) {
  const option = await screen.findByRole("option", { name })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(option, { key: "Enter" })
}

describe("TeamRoleSelect (AQU-1352 P2)", () => {
  it("offers Inherit / Viewer / Project Lead / Maintainer and sends the chosen level", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(<TeamRoleSelect username="carol" value={null} canEdit maxLevel={600} onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Team-wide role of carol" }))
    expect(await screen.findByRole("option", { name: "Maintainer" })).toBeTruthy()
    await pick("Project lead")
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(500))
  })

  it("choosing Inherit clears the team role (null)", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined)
    render(<TeamRoleSelect username="carol" value={100} canEdit maxLevel={600} onChange={onChange} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Team-wide role of carol" }))
    await pick("Inherit")
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
  })

  it("does not offer levels above the caller's own (no self-escalation)", async () => {
    render(<TeamRoleSelect username="carol" value={null} canEdit maxLevel={500} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Team-wide role of carol" }))
    expect(await screen.findByRole("option", { name: "Project lead" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Maintainer" })).toBeNull()
  })

  it("read-only for callers who cannot edit: a label, no picker", () => {
    render(<TeamRoleSelect username="carol" value={500} canEdit={false} maxLevel={100} onChange={vi.fn()} />)
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.getByText("Project lead")).toBeTruthy()
  })
})
