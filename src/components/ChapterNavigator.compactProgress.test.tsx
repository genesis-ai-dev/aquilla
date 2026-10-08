import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"

/**
 * AQU-1485 — the milestone picker used to spell out "N% translated" / "N%
 * validated" on every row. In a fixed-width dropdown that column took over 40%
 * of the row, leaving titles about 12 characters: six consecutive
 * "1 Corinthians …" milestones all rendered "1 Corinthian…" and could not be
 * told apart, with no hover text to reach the full title.
 *
 * These guard the contract that replaced it: the wording survives for hover and
 * for assistive tech, but not in the row's visible layout — so the column's
 * width no longer depends on how long a locale's words for it are.
 *
 * happy-dom has no layout engine, so scrollWidth/clientWidth are both 0 by
 * default; the clipping tests stub them on the element prototype to stand in
 * for the measurement the component reads in a real browser (same approach as
 * `ui/expandable-name.test.tsx`).
 */
function mockLayout({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return scrollWidth
    },
  })
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return clientWidth
    },
  })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth")
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
})

const corinthians: MilestoneNavigationItem[] = [
  {
    key: "scripture:1CO:1",
    kind: "chapter",
    label: "1 Corinthians 1:1–31",
    shortLabel: "1",
    description: "31 cells",
    translated: 31,
    validated: 31,
    total: 31,
  },
  {
    key: "scripture:1CO:2",
    kind: "chapter",
    label: "1 Corinthians 2:1–16",
    shortLabel: "2",
    description: "16 cells",
    translated: 4,
    validated: 0,
    total: 16,
  },
]

const openPicker = () =>
  fireEvent.click(screen.getByRole("combobox", { name: /Current chapter: 1 Corinthians 1:1–31/ }))

describe("MilestoneNavigator progress column (AQU-1485)", () => {
  it("keeps the spelled-out progress wording out of the row's visible layout", () => {
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    openPicker()

    // The words are present, but only for a screen reader — not taking row
    // width away from the title.
    for (const wording of ["25% translated", "0% validated", "100% translated", "100% validated"]) {
      expect(screen.getByText(wording), wording).toHaveClass("sr-only")
    }

    // What the row actually shows beside each marker icon is the bare
    // percentage.
    expect(screen.getByText("25%")).toBeInTheDocument()
    expect(screen.getAllByText("100%")).toHaveLength(2)
  })

  it("still announces the full wording as part of each row's accessible name", () => {
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    openPicker()

    expect(
      screen.getByRole("option", {
        name: /1 Corinthians 2:1–16 16 cells 25% translated 0% validated/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("option", {
        name: /1 Corinthians 1:1–31 31 cells 100% translated 100% validated/,
      }),
    ).toBeInTheDocument()
  })

  it("names what each percentage measures as hover text on its marker", () => {
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    openPicker()

    expect(screen.getByText("25% translated").closest("[title]")).toHaveAttribute(
      "title",
      "25% translated",
    )
    expect(screen.getByText("0% validated").closest("[title]")).toHaveAttribute(
      "title",
      "0% validated",
    )
  })
})

describe("MilestoneNavigator clipped titles (AQU-1485)", () => {
  it("reveals a row title that still does not fit as hover text", () => {
    mockLayout({ scrollWidth: 400, clientWidth: 128 })
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    openPicker()

    expect(screen.getByText("1 Corinthians 2:1–16")).toHaveAttribute(
      "title",
      "1 Corinthians 2:1–16",
    )
  })

  it("leaves a row title that fits without hover text", () => {
    mockLayout({ scrollWidth: 80, clientWidth: 128 })
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    openPicker()

    expect(screen.getByText("1 Corinthians 2:1–16")).not.toHaveAttribute("title")
  })

  it("reveals the current milestone on the trigger only when the trigger clips it", () => {
    mockLayout({ scrollWidth: 400, clientWidth: 128 })
    const { unmount } = render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    expect(
      screen.getByRole("combobox", { name: /Current chapter: 1 Corinthians 1:1–31/ }),
    ).toHaveAttribute("title", "1 Corinthians 1:1–31")
    unmount()

    mockLayout({ scrollWidth: 80, clientWidth: 128 })
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )
    expect(
      screen.getByRole("combobox", { name: /Current chapter: 1 Corinthians 1:1–31/ }),
    ).not.toHaveAttribute("title")
  })

  it("keeps the trigger's hover text when its label is hidden outright", () => {
    // The collapsed icon-only trigger hides the label with `display: none`,
    // which reports 0×0 — none of the title is readable, so hover stays the way
    // to read it.
    mockLayout({ scrollWidth: 0, clientWidth: 0 })
    render(
      <MilestoneNavigator items={corinthians} activeKey="scripture:1CO:1" onSelect={() => {}} />,
    )

    expect(
      screen.getByRole("combobox", { name: /Current chapter: 1 Corinthians 1:1–31/ }),
    ).toHaveAttribute("title", "1 Corinthians 1:1–31")
  })

  it("never shows 100% beside the marker while a cell is left (AQU-1493)", () => {
    const jude: MilestoneNavigationItem[] = [
      {
        key: "scripture:JUD:1",
        kind: "chapter",
        label: "Jude 1:1–25",
        shortLabel: "1",
        description: "220 cells",
        translated: 219,
        validated: 219,
        total: 220,
      },
    ]
    render(<MilestoneNavigator items={jude} activeKey="scripture:JUD:1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("combobox", { name: /Current chapter: Jude 1:1–25/ }))

    expect(screen.getAllByText("99%")).toHaveLength(2)
    expect(screen.queryByText("100%")).not.toBeInTheDocument()
    expect(screen.getByText("99% translated")).toHaveClass("sr-only")
  })
})
