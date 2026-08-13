import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { Bot, Scale } from "lucide-react"
import { TabStrip } from "./TabStrip"

describe("TabStrip surface tabs", () => {
  it("keeps an inactive Agent tab visible beside open files", () => {
    render(
      <TabStrip
        tabs={[{ id: "t1", fileId: "f1" }]}
        activeTabId="t1"
        files={[{ id: "f1", name: "GEN.usfm" }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            icon: Bot,
            active: false,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    expect(screen.getByRole("tab", { name: /GEN\.usfm/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /^Agent/ })).toHaveAttribute("aria-selected", "false")
  })

  it("activates a surface tab on click", () => {
    const onActivate = vi.fn()
    render(
      <TabStrip
        tabs={[{ id: "t1", fileId: "f1" }]}
        activeTabId="t1"
        files={[{ id: "f1", name: "GEN.usfm" }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            icon: Bot,
            active: false,
            onActivate,
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    fireEvent.click(within(screen.getByRole("tab", { name: /^Agent/ })).getByRole("button", { name: "Agent" }))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("closes the Agent surface tab via its close control", () => {
    const onClose = vi.fn()
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        files={[]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            icon: Bot,
            active: true,
            onActivate: vi.fn(),
            onClose,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Close Agent" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("can show Rules and Agent surface tabs together", () => {
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        files={[]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "rules",
            label: "Rules",
            icon: Scale,
            active: true,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
          {
            id: "agent",
            label: "Agent",
            icon: Bot,
            active: false,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    expect(screen.getByRole("tab", { name: /^Rules/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /^Agent/ })).toHaveAttribute("aria-selected", "false")
  })
})
