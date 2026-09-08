import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"

import { AccountMenuEntry } from "@/components/AccountSwitcher"
import { TooltipProvider } from "@/components/ui/tooltip"

vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/ui/dropdown-menu")>()
  return {
    ...original,
    DropdownMenuItem: ({
      children,
      onSelect: _onSelect,
      ...props
    }: ComponentProps<"button"> & { onSelect?: (event: Event) => void }) => (
      <button type="button" role="menuitem" {...props}>
        {children}
      </button>
    ),
  }
})

describe("AccountMenuEntry", () => {
  it("reserves the visible row for the full username and reveals email on hover", async () => {
    render(
      <TooltipProvider delay={0}>
        <AccountMenuEntry
          summary={{
            key: "account-1",
            username: "a-complete-long-username",
            email: "person@example.com",
            active: true,
          }}
        />
      </TooltipProvider>,
    )

    const username = screen.getByText("a-complete-long-username")

    expect(username).not.toHaveClass("truncate")
    expect(screen.queryByText("person@example.com")).not.toBeInTheDocument()

    fireEvent.pointerEnter(username, { pointerType: "mouse" })
    fireEvent.mouseEnter(username)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("person@example.com")
    })
  })

  it("does not create tooltip content when the session has no email", () => {
    render(
      <TooltipProvider delay={0}>
        <AccountMenuEntry
          summary={{
            key: "account-2",
            username: "username-only",
            active: false,
          }}
        />
      </TooltipProvider>,
    )

    expect(screen.getByText("username-only")).toBeVisible()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
})
