// AQU-1153: the username/email mode switch is the app's shared Tabs control,
// not a hand-rolled pill pair. These tests pin the two things a reviewer on the
// "Add to projects" dialog cares about: the control is really tabs (so it looks
// and behaves like every other mode switch), and swapping modes still clears
// the recipient — which is what lets the caller clamp the role picker.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"
import { UsernameTypeahead, type RecipientValue } from "./UsernameTypeahead"

vi.mock("@/hooks/useUserSearch", () => ({
  useUserSearch: (query: string) => ({
    query,
    results: [],
    isLoading: false,
    needsMorePrefix: query.trim().length < 2,
    lastFetchOk: true,
  }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" }, loading: false }),
}))
vi.mock("@/lib/frontier/members", () => ({
  lookupUser: vi.fn(async () => null),
}))

function Harness({
  showModeToggle = true,
  disabled,
  onChange,
  initial = { mode: "username", raw: "" },
}: {
  showModeToggle?: boolean
  disabled?: boolean
  onChange?: (next: RecipientValue) => void
  initial?: RecipientValue
}) {
  const [value, setValue] = useState<RecipientValue>(initial)
  return (
    <UsernameTypeahead
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
      showModeToggle={showModeToggle}
      disabled={disabled}
    />
  )
}

describe("UsernameTypeahead mode switch (AQU-1153)", () => {
  it("renders the mode switch as tabs, with the current mode selected", () => {
    render(<Harness />)

    expect(screen.getByRole("tablist")).toBeInTheDocument()
    const username = screen.getByRole("tab", { name: "@user" })
    const email = screen.getByRole("tab", { name: "Email" })
    expect(username).toHaveAttribute("aria-selected", "true")
    expect(email).toHaveAttribute("aria-selected", "false")
  })

  it("selecting the Email tab switches mode and clears the typed recipient", () => {
    const onChange = vi.fn()
    render(<Harness initial={{ mode: "username", raw: "bob", resolved: { id: 1, username: "bob" } }} onChange={onChange} />)

    fireEvent.click(screen.getByRole("tab", { name: "Email" }))

    expect(onChange).toHaveBeenCalledWith({ mode: "email", raw: "", resolved: undefined })
    expect(screen.getByRole("tab", { name: "Email" })).toHaveAttribute("aria-selected", "true")
  })

  it("selecting the @user tab switches back and clears the typed email", () => {
    const onChange = vi.fn()
    render(<Harness initial={{ mode: "email", raw: "bob@example.com" }} onChange={onChange} />)

    fireEvent.click(screen.getByRole("tab", { name: "@user" }))

    expect(onChange).toHaveBeenCalledWith({ mode: "username", raw: "", resolved: undefined })
    expect(screen.getByRole("tab", { name: "@user" })).toHaveAttribute("aria-selected", "true")
  })

  it("refuses a mode switch while the caller is busy", () => {
    // Base UI marks a disabled tab with aria-disabled rather than the native
    // attribute, so the tooltip still works on hover — but activation is inert.
    const onChange = vi.fn()
    render(<Harness disabled onChange={onChange} />)

    const email = screen.getByRole("tab", { name: "Email" })
    expect(screen.getByRole("tab", { name: "@user" })).toHaveAttribute("aria-disabled", "true")
    expect(email).toHaveAttribute("aria-disabled", "true")

    fireEvent.click(email)
    expect(onChange).not.toHaveBeenCalled()
    expect(email).toHaveAttribute("aria-selected", "false")
  })

  it("renders no mode switch for surfaces that pin a single mode", () => {
    render(<Harness showModeToggle={false} />)

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })
})
