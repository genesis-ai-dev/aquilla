// AQU-2260 (Sam, Oct 29): the environment badge says what it means on a click,
// never on hover; the build button's hover only shows the build it copies.
import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { VersionBadge, VersionTag } from "./VersionBadge"

describe("VersionTag", () => {
  it("the build button's hover names the build and nothing more", async () => {
    renderWithTooltips(<MemoryRouter><VersionTag /></MemoryRouter>)
    await userEvent.setup().hover(screen.getByRole("button", { name: "Copy build info" }))
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).not.toMatch(/Click to copy/)
  })

  it("the environment badge says what it means, on click", async () => {
    renderWithTooltips(<MemoryRouter><VersionTag /></MemoryRouter>)
    const badge = screen.queryByRole("button", { name: /Not production/ })
    // Production builds draw no badge at all; every test build is not production.
    expect(badge).not.toBeNull()
    await expectClickNote(badge!, /nothing you see here is production data/)
  })
})

describe("VersionBadge", () => {
  it("auth pages show one inline build control instead of a floating duplicate", () => {
    renderWithTooltips(<MemoryRouter initialEntries={["/join"]}>
      <VersionBadge /><VersionBadge inline />
    </MemoryRouter>)
    expect(screen.getAllByRole("button", { name: "Copy build info" })).toHaveLength(1)
  })

  it("the floating build button's hover names the build and nothing more", async () => {
    renderWithTooltips(<MemoryRouter initialEntries={["/not-found"]}><VersionBadge /></MemoryRouter>)
    await userEvent.setup().hover(screen.getByRole("button", { name: "Copy build info" }))
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).not.toMatch(/Click to copy/)
  })
})
