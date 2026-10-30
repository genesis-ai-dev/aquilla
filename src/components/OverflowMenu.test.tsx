import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { toSections } from "./overflow-menu-sections"

// AQU-358: the chapter row used to carry a labelled split button with its own
// chevron menu BESIDE the ⋯, with nothing to say which held what. The menus are
// one menu now, so a `label` item names the run of items under it.
describe("toSections", () => {
  it("keeps an unlabelled menu as one group, separators inline", () => {
    const items: OverflowMenuItem[] = [
      { id: "a", label: "A" },
      { id: "sep", type: "separator" },
      { id: "b", label: "B" },
    ]

    expect(toSections(items)).toEqual([
      { id: "overflow-menu-lead", items, dividerAbove: false },
    ])
  })

  it("starts a new group at every heading", () => {
    const sections = toSections([
      { id: "tools-heading", type: "label", label: "Editor tools" },
      { id: "check-file", label: "Check file" },
      { id: "runs-heading", type: "label", label: "Run on this file" },
      { id: "run-completions", label: "Run AI completions" },
      { id: "complete-all", label: "Draft all" },
    ])

    expect(sections.map((s) => [s.heading, s.items.map((i) => i.id)])).toEqual([
      ["Editor tools", ["check-file"]],
      ["Run on this file", ["run-completions", "complete-all"]],
    ])
  })

  it("hoists a separator that closed the previous run above the next heading", () => {
    const sections = toSections([
      { id: "check-file", label: "Check file" },
      { id: "sep", type: "separator" },
      { id: "runs-heading", type: "label", label: "Run on this file" },
      { id: "run-completions", label: "Run AI completions" },
    ])

    // The separator is gone from the group it closed — it renders once, above
    // the heading, rather than dangling under the last item AND being doubled
    // by the heading's own spacing.
    expect(sections[0]).toEqual({
      id: "overflow-menu-lead",
      items: [{ id: "check-file", label: "Check file" }],
      dividerAbove: false,
    })
    expect(sections[1]?.dividerAbove).toBe(true)
    expect(sections[1]?.items.map((i) => i.id)).toEqual(["run-completions"])
  })

  it("draws one rule where several callers' lists each ended in their own", () => {
    // The chapter toolbar concatenates its own items, its separator, and the
    // workspace's list, which opens with a separator of its own.
    const sections = toSections([
      { id: "tools-heading", type: "label", label: "Editor tools" },
      { id: "check-file", label: "Check file" },
      { id: "toolbar-separator", type: "separator" },
      { id: "workspace-separator", type: "separator" },
      { id: "runs-heading", type: "label", label: "Run on this file" },
      { id: "run-completions", label: "Run AI completions" },
    ])

    expect(sections[0]?.items.map((i) => i.id)).toEqual(["check-file"])
    expect(sections[1]?.dividerAbove).toBe(true)
    expect(sections[1]?.items.map((i) => i.id)).toEqual(["run-completions"])
  })

  it("never opens the menu with a rule, even if the first run emptied out", () => {
    const sections = toSections([
      { id: "runs-heading", type: "label", label: "Run on this file" },
      { id: "sep", type: "separator" },
      { id: "view-heading", type: "label", label: "View & navigate" },
      { id: "view-settings", label: "View settings" },
    ])

    expect(sections.map((s) => [s.heading, s.dividerAbove])).toEqual([
      ["View & navigate", false],
    ])
  })

  it("drops a heading whose items were all filtered out upstream", () => {
    const sections = toSections([
      { id: "runs-heading", type: "label", label: "Run on this file" },
      { id: "sep", type: "separator" },
      { id: "file-heading", type: "label", label: "This file" },
      { id: "file-rename", label: "Rename" },
    ])

    expect(sections.map((s) => s.heading)).toEqual(["This file"])
  })
})

describe("OverflowMenu headings", () => {
  it("renders a heading as a group name, not as something clickable", async () => {
    const onClick = vi.fn()
    render(
      <OverflowMenu
        ariaLabel="File options"
        items={[
          { id: "runs-heading", type: "label", label: "Run on this file" },
          { id: "run-completions", label: "Run AI completions", onClick },
        ]}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "File options" }))
    expect(screen.getByText("Run on this file")).toBeVisible()
    expect(screen.queryByRole("menuitem", { name: "Run on this file" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("menuitem", { name: "Run AI completions" }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

// AQU-2260 (Sam, Oct 29): a menu item's (i) — what it does, or why it is
// greyed out — opens its text in place under the item on CLICK, and shuts on a
// second click. It never activates the item, and hovering shows nothing.
describe("OverflowMenu item (i)", () => {
  async function openMenu(items: OverflowMenuItem[]) {
    render(<OverflowMenu ariaLabel="File options" items={items} />)
    await userEvent.click(screen.getByRole("button", { name: "File options" }))
  }

  it("opens an item's description in place, without running the item", async () => {
    const onClick = vi.fn()
    await openMenu([{ id: "draft", label: "Draft as you read", description: "Drafts each line as you reach it.", onClick, testId: "draft" }])
    const info = screen.getByRole("button", { name: "About Draft as you read" })
    await userEvent.hover(info)
    expect(screen.queryByRole("tooltip")).toBeNull()
    const text = document.getElementById(info.getAttribute("aria-controls")!)!
    expect(text).toHaveAttribute("data-open", "false")
    await userEvent.click(info)
    expect(text).toHaveAttribute("data-open", "true")
    expect(text).toHaveTextContent("Drafts each line as you reach it.")
    expect(onClick).not.toHaveBeenCalled()
    await userEvent.click(info)
    expect(text).toHaveAttribute("data-open", "false")
    // The item still names itself plainly, and describes itself to a reader.
    expect(screen.getByRole("menuitem", { name: "Draft as you read" })).toHaveAccessibleDescription("Drafts each line as you reach it.")
  })

  it("says why a greyed-out item is off behind its (i), not on hover", async () => {
    await openMenu([{ id: "captions", label: "Attach captions", disabled: true, disabledReason: "Track editing is off for this project.", testId: "captions" }])
    const item = screen.getByRole("menuitem", { name: "Attach captions" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    await userEvent.hover(item)
    expect(screen.queryByRole("tooltip")).toBeNull()
    const info = screen.getByRole("button", { name: "About Attach captions" })
    await userEvent.click(info)
    expect(document.getElementById(info.getAttribute("aria-controls")!)).toHaveTextContent("Track editing is off for this project.")
  })
})
