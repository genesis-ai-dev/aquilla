/**
 * ContextMenu — right-clicking elsewhere while a menu is open moves the one menu
 * rather than cross-dissolving two popups, which the popup reports as
 * `data-instant="trigger-change"`.
 *
 * Assertions are on that value rather than on the bare attribute: Base UI sets
 * `data-instant="click"` itself on every mouse-driven open in a real browser
 * (untrusted test events don't reproduce it), and only `trigger-change` is
 * wired to suppress the animation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu"

/**
 * Clock is driven explicitly so the reposition window never depends on machine
 * speed. It only ever moves forward: the window is module state shared by every
 * root, so rewinding it would leak one test's reposition into the next.
 */
let now = 1_700_000_000_000

beforeEach(() => {
  now += 60_000
  vi.spyOn(Date, "now").mockImplementation(() => now)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function TwoRows() {
  return (
    <>
      {["Alpha", "Beta"].map((name) => (
        <ContextMenu key={name}>
          <ContextMenuTrigger>{name}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Act on {name}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </>
  )
}

const popups = () =>
  Array.from(document.querySelectorAll('[data-slot="context-menu-content"]'))

const openPopup = () =>
  document.querySelector('[data-slot="context-menu-content"][data-open]')

/** The press that dismisses the open menu when another trigger is right-clicked. */
const rightPress = (target: Element) =>
  fireEvent.pointerDown(target, { button: 2, buttons: 2 })

describe("ContextMenu reposition", () => {
  it("animates a menu opened from a cold right-click", () => {
    render(<TwoRows />)

    fireEvent.contextMenu(screen.getByText("Alpha"))

    expect(openPopup()).toBeTruthy()
    expect(openPopup()).not.toHaveAttribute("data-instant", "trigger-change")
  })

  it("snaps the menu when another trigger is right-clicked while open", () => {
    render(<TwoRows />)

    fireEvent.contextMenu(screen.getByText("Alpha"))
    expect(openPopup()).not.toHaveAttribute("data-instant", "trigger-change")

    const beta = screen.getByText("Beta")
    rightPress(beta)
    now += 8 // the browser's own gap between pointerdown and contextmenu
    fireEvent.contextMenu(beta)

    expect(screen.getByRole("menuitem", { name: "Act on Beta" })).toBeInTheDocument()
    expect(openPopup()).toHaveAttribute("data-instant", "trigger-change")
    // The attribute is only half the contract — it has to defeat the enter and
    // exit utilities carried by the same element.
    expect(openPopup()).toHaveClass("data-[instant=trigger-change]:animate-none!")
    expect(openPopup()).toHaveClass("data-open:animate-in")
  })

  it("animates again once the reposition window has passed", () => {
    render(<TwoRows />)

    fireEvent.contextMenu(screen.getByText("Alpha"))
    const beta = screen.getByText("Beta")
    rightPress(beta)

    now += 1_000
    fireEvent.contextMenu(beta)

    expect(openPopup()).not.toHaveAttribute("data-instant", "trigger-change")
  })

  it("treats a plain left click as a dismiss, not the start of a reposition", () => {
    render(<TwoRows />)

    const beta = screen.getByText("Beta")
    fireEvent.contextMenu(screen.getByText("Alpha"))
    fireEvent.pointerDown(beta, { button: 0 })
    expect(popups()).toHaveLength(0)

    now += 8
    fireEvent.contextMenu(beta)

    expect(openPopup()).not.toHaveAttribute("data-instant", "trigger-change")
  })

  it("keeps the submenu entrance after a reposition", () => {
    render(
      <>
        <ContextMenu>
          <ContextMenuTrigger>Alpha</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Act on Alpha</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <ContextMenu>
          <ContextMenuTrigger>Beta</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuSub defaultOpen>
              <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem>Nested</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuContent>
        </ContextMenu>
      </>,
    )

    fireEvent.contextMenu(screen.getByText("Alpha"))
    const beta = screen.getByText("Beta")
    rightPress(beta)
    now += 8
    fireEvent.contextMenu(beta)

    expect(openPopup()).toHaveAttribute("data-instant", "trigger-change")
    const sub = document.querySelector('[data-slot="context-menu-sub-content"]')
    expect(sub).toBeTruthy()
    expect(sub).not.toHaveAttribute("data-instant", "trigger-change")
  })
})
