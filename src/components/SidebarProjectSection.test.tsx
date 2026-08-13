import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { BookOpen, MessagesSquare, Scale, Trash2 } from "lucide-react"
import { SidebarProjectSection } from "./SidebarProjectSection"

describe("SidebarProjectSection", () => {
  it("renders pinned items in order and tucks the rest under More", () => {
    render(
      <SidebarProjectSection
        items={[
          { id: "rules", label: "Rules", icon: Scale, onClick: vi.fn() },
          {
            id: "comments",
            label: "Comments",
            icon: MessagesSquare,
            pinned: true,
            onClick: vi.fn(),
          },
          {
            id: "terminology",
            label: "Terminology",
            icon: BookOpen,
            pinned: true,
            onClick: vi.fn(),
          },
          { id: "trash", label: "Recently deleted", icon: Trash2, onClick: vi.fn() },
        ]}
      />,
    )

    const comments = screen.getByRole("button", { name: /^Comments$/i })
    const terminology = screen.getByRole("button", { name: /^Terminology$/i })
    const more = screen.getByRole("button", { name: /^More project options$/i })

    // Comments then Terminology are always visible; overflow stays behind More.
    expect(comments.compareDocumentPosition(terminology) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(terminology.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^Rules$/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Recently deleted$/i })).toBeNull()

    fireEvent.click(more)
    // Popover content mounts in the portal; happy-dom may not mark it "visible"
    // the way a browser does, so assert presence + clickability instead.
    expect(screen.getByRole("button", { name: /^Rules$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Recently deleted$/i })).toBeInTheDocument()
  })

  // Opening the popover inserts Base UI focus-guard spans next to the trigger.
  // Those guards must not become siblings of Comments/Terminology in the nav
  // list — space-y margins on the extra siblings used to grow the section and
  // jump the More row upward when pressed.
  it("keeps More wrapped so focus guards stay out of the nav list", () => {
    const { container } = render(
      <SidebarProjectSection
        items={[
          {
            id: "comments",
            label: "Comments",
            icon: MessagesSquare,
            pinned: true,
            onClick: vi.fn(),
          },
          {
            id: "terminology",
            label: "Terminology",
            icon: BookOpen,
            pinned: true,
            onClick: vi.fn(),
          },
          { id: "trash", label: "Recently deleted", icon: Trash2, onClick: vi.fn() },
        ]}
      />,
    )

    const more = screen.getByRole("button", { name: /^More project options$/i })
    const navList = container.querySelector(".flex.flex-col.gap-0\\.5")
    expect(navList).not.toBeNull()
    expect(navList!.children).toHaveLength(3)
    // More lives inside a wrapper; Comments/Terminology are direct rows.
    expect(navList!.children[0]).toBe(screen.getByRole("button", { name: /^Comments$/i }))
    expect(navList!.children[1]).toBe(screen.getByRole("button", { name: /^Terminology$/i }))
    expect(navList!.children[2].contains(more)).toBe(true)
    expect(navList!.children[2]).not.toBe(more)
  })
})
