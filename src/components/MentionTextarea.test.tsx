import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { MentionTextarea } from "./MentionTextarea"

const ROSTER = [{ username: "bob" }, { username: "bobby" }, { username: "carol" }]

function Harness({
  onKeyDown,
}: {
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const [value, setValue] = useState("Check ")
  return (
    <MentionTextarea
      value={value}
      onChange={setValue}
      candidates={ROSTER}
      currentUsername="alice"
      aria-labelledby="label"
      onKeyDown={onKeyDown}
    />
  )
}

describe("MentionTextarea", () => {
  it("inserts the highlighted member with Enter and leaves Cmd+Enter to the caller", async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <>
        <span id="label">Comment</span>
        <Harness onKeyDown={onKeyDown} />
      </>,
    )
    const field = screen.getByRole("textbox", { name: "Comment" })
    await user.type(field, "@bo")
    expect(screen.getByRole("option", { name: "@bob" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: "@bobby" })).toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(field.querySelector("[data-mention='bob']")).toHaveTextContent("@bob")
    expect(field).toHaveTextContent("Check @bob")
    expect(onKeyDown.mock.calls.some(([event]) => event.key === "Enter")).toBe(false)

    await user.keyboard("{Meta>}{Enter}{/Meta}")
    expect(onKeyDown.mock.calls.some(([event]) => event.key === "Enter" && event.metaKey)).toBe(true)
  })

  it("does not offer a mention for an email address", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const field = screen.getByRole("textbox")
    await user.clear(field)
    await user.type(field, "me@bob.com")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
  })

  it("leaves a typed @name as plain text when Escape closes the list", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const field = screen.getByRole("textbox")
    await user.type(field, "@bob")
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(field.querySelector("[data-mention]")).not.toBeInTheDocument()
    expect(field).toHaveTextContent("Check @bob")
  })

  it("closes the list on Escape without inserting", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const field = screen.getByRole("textbox")
    await user.type(field, "@")
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    expect(field.querySelector("[data-mention]")).not.toBeInTheDocument()
    expect(field).toHaveTextContent("Check @")
  })
})
