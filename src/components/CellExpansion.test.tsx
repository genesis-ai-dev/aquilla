import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { CellExpansion, type CellExpansionTab } from "./CellExpansion"

function Harness({ tabs, onClose }: { tabs: CellExpansionTab[]; onClose?: () => void }) {
  const [tab, setTab] = useState("backtranslation")
  return (
    <CellExpansion
      open
      tab={tab}
      onTabChange={setTab}
      tabs={tabs}
      onClose={onClose}
    />
  )
}

const SAMPLE_TABS: CellExpansionTab[] = [
  {
    value: "backtranslation",
    icon: <span aria-hidden="true">BT</span>,
    label: "Backtranslation",
    renderContent: () => <div>BT body</div>,
  },
]

describe("CellExpansion", () => {
  it("renders only the active tab body", () => {
    const renderBacktranslation = vi.fn(() => <div>BT body</div>)
    const renderHistory = vi.fn(() => <div>History body</div>)

    render(
      <Harness
        tabs={[
          {
            value: "backtranslation",
            icon: <span aria-hidden="true">BT</span>,
            label: "Backtranslation",
            renderContent: renderBacktranslation,
          },
          {
            value: "history",
            icon: <span aria-hidden="true">H</span>,
            label: "History",
            renderContent: renderHistory,
          },
        ]}
      />,
    )

    expect(renderBacktranslation).toHaveBeenCalledTimes(1)
    expect(renderHistory).not.toHaveBeenCalled()
    expect(screen.getByText("BT body")).toBeInTheDocument()
    expect(screen.queryByText("History body")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: /history/i }))

    expect(renderHistory).toHaveBeenCalledTimes(1)
    expect(screen.getByText("History body")).toBeInTheDocument()
    expect(screen.queryByText("BT body")).not.toBeInTheDocument()
  })

  // AQU-588: the panel must offer a visible, labelled close affordance — not
  // only the (undiscoverable) rail chevron / Esc — whenever onClose is wired.
  it("renders a labelled close button that invokes onClose", () => {
    const onClose = vi.fn()
    render(<Harness tabs={SAMPLE_TABS} onClose={onClose} />)

    const closeButton = screen.getByRole("button", { name: /close cell details/i })
    fireEvent.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("omits the close button when onClose is not provided", () => {
    render(<Harness tabs={SAMPLE_TABS} />)

    expect(screen.queryByRole("button", { name: /close cell details/i })).not.toBeInTheDocument()
  })
})
