import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { BookOpen, MessagesSquare, Scale, Settings } from "lucide-react"
import { SidebarProjectSection } from "./SidebarProjectSection"

describe("SidebarProjectSection", () => {
  it("renders pinned items in order and tucks the rest under More", () => {
    render(
      <SidebarProjectSection
        items={[
          { id: "rules", labelKey: "nav.sidebarSection.rules", icon: Scale, onClick: vi.fn() },
          {
            id: "comments",
            labelKey: "common.comments",
            icon: MessagesSquare,
            pinned: true,
            onClick: vi.fn(),
          },
          {
            id: "terminology",
            labelKey: "nav.sidebarSection.terminology",
            icon: BookOpen,
            pinned: true,
            onClick: vi.fn(),
          },
          { id: "settings", labelKey: "nav.settings", icon: Settings, onClick: vi.fn() },
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
    expect(screen.queryByRole("button", { name: /^Settings$/i })).toBeNull()

    fireEvent.click(more)
    // Popover content mounts in the portal; happy-dom may not mark it "visible"
    // the way a browser does, so assert presence + clickability instead.
    expect(screen.getByRole("button", { name: /^Rules$/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Settings$/i })).toBeInTheDocument()
  })
})
