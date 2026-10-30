// AQU-2260 (Sam, Oct 29): the two invite modes are labelled tabs, so they say
// nothing on hover; what each does is in one (i) beside them, opened on click.
// The "verified" mark says what it means on a click too.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { UsernameTypeahead } from "./UsernameTypeahead"

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: () => ({ query: "", results: [], isLoading: false, lastFetchOk: true }),
}))
vi.mock("@/hooks/useExactUserLookup", () => ({
  useExactUserLookup: () => ({ status: "idle", user: null }),
}))

describe("UsernameTypeahead", () => {
  it("the mode tabs show nothing on hover; the (i) beside them says what each does", async () => {
    renderWithTooltips(<UsernameTypeahead value={{ mode: "username", raw: "" }} onChange={vi.fn()} />)
    const user = userEvent.setup()
    for (const name of ["@user", "Email"]) {
      await user.hover(screen.getByRole("tab", { name }))
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByRole("tooltip")).toBeNull()
    }
    await expectClickNote(
      screen.getByRole("button", { name: "About @user and Email" }),
      /Invite an existing Aquilla user[\s\S]*prompted to sign up if needed/,
    )
  })

  it("the verified mark says what it means, on click", async () => {
    renderWithTooltips(
      <UsernameTypeahead value={{ mode: "username", raw: "anna", resolved: { id: 4, username: "anna" } }} onChange={vi.fn()} />,
    )
    await expectClickNote(screen.getByRole("button", { name: /verified/ }), "Verified Aquilla user")
  })
})
