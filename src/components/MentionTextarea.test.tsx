import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { MentionTextarea } from "./MentionTextarea"
import type { MentionCandidate } from "@/lib/comments/mention-suggest"

const ROSTER = [{ username: "bob" }, { username: "bobby" }, { username: "carol" }]

function Harness({
  onKeyDown,
  candidates = ROSTER,
  restricted = false,
}: {
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
  candidates?: readonly MentionCandidate[]
  restricted?: boolean
}) {
  const [value, setValue] = useState("Check ")
  return (
    <>
      <MentionTextarea
        value={value}
        onChange={setValue}
        candidates={candidates}
        restricted={restricted}
        currentUsername="alice"
        aria-labelledby="label"
        onKeyDown={onKeyDown}
      />
      <pre data-testid="stored">{value}</pre>
    </>
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

  // AQU-761 bot walk: picking `@qa-bot-2` left the plain text `@[qa-bot-2]`
  // in the composer and the posted comment, so no chip and no notice.
  it("stores a hyphenated username as one chip", async () => {
    const user = userEvent.setup()
    render(<Harness candidates={[{ username: "qa-bot-2" }, { username: "qa_bot_mention" }]} />)
    const field = screen.getByRole("textbox")
    await user.type(field, "@qa-b")
    expect(screen.getByRole("option", { name: "@qa-bot-2" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("option", { name: "@qa_bot_mention" })).not.toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(field.querySelector("[data-mention='qa-bot-2']")).toHaveTextContent("@qa-bot-2")
    expect(field).toHaveTextContent("Check @qa-bot-2")
    expect(screen.getByTestId("stored")).toHaveTextContent("Check @[qa-bot-2]")
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

  it("draws an empty suggestion list at the same text size as menus", async () => {
    const user = userEvent.setup()
    render(
      <>
        <span id="label">Comment</span>
        <Harness />
      </>,
    )
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "@zzz")
    const list = screen.getByRole("listbox")
    expect(list.className).toContain("text-sm")
    expect(list.className).not.toContain("text-[11px]")
    const empty = screen.getByText("No users found.")
    expect(empty.className).toContain("text-sm")
    expect(empty.className).not.toContain("text-[11px]")
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

/**
 * AQU-1815: a Contributor the org hides the roster from gets a lane-scoped
 * list. When even that is empty the composer must not claim the project has
 * no one on it.
 */
describe("MentionTextarea — empty list copy", () => {
  it("says the list is lane-scoped when the roster is hidden from the author", async () => {
    const user = userEvent.setup()
    render(
      <>
        <span id="label">Comment</span>
        <Harness candidates={[]} restricted />
      </>,
    )
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "@")
    expect(screen.getByText("No one in your lanes to mention yet.")).toBeInTheDocument()
    expect(screen.queryByText("No one on this project to mention.")).not.toBeInTheDocument()
  })

  it("keeps the project-wide copy when the full roster is simply empty", async () => {
    const user = userEvent.setup()
    render(
      <>
        <span id="label">Comment</span>
        <Harness candidates={[]} />
      </>,
    )
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "@")
    expect(screen.getByText("No one on this project to mention.")).toBeInTheDocument()
  })

  it("reports no match, not an empty list, when a lane-scoped list has no hit", async () => {
    const user = userEvent.setup()
    render(
      <>
        <span id="label">Comment</span>
        <Harness candidates={[{ username: "carol" }]} restricted />
      </>,
    )
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "@zz")
    expect(screen.getByText("No users found.")).toBeInTheDocument()
  })
})
