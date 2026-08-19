import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DateTooltip } from "./date-tooltip"
import { TooltipProvider } from "@/components/ui/tooltip"
import { fmtDeadlineDate, fmtLabeledDeadlineDate, fmtLabeledDateTime, fmtShortCalendarDate } from "@/lib/format-date"

const EDITED_AT = new Date(2026, 6, 3, 13, 37, 8).getTime()

describe("DateTooltip", () => {
  it("shows a short calendar date and a labeled datetime on hover", async () => {
    render(
      <TooltipProvider delay={0}>
        <DateTooltip value={EDITED_AT} label="Edited" />
      </TooltipProvider>,
    )

    const trigger = screen.getByText(fmtShortCalendarDate(EDITED_AT))
    expect(trigger).toBeInTheDocument()

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        fmtLabeledDateTime(EDITED_AT, "Edited"),
      )
    }, { timeout: 250 })
  })

  it("renders nothing for a missing timestamp", () => {
    const { container } = render(<DateTooltip value={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows month and day for a deadline in the current year", () => {
    const thisYear = `${new Date().getFullYear()}-06-02`
    render(
      <TooltipProvider delay={0}>
        <DateTooltip value={thisYear} label="Due" variant="deadline" />
      </TooltipProvider>,
    )
    expect(screen.getByText(fmtDeadlineDate(thisYear))).toBeInTheDocument()
    expect(screen.queryByText(/, \d{4}$/)).not.toBeInTheDocument()
  })

  it("includes the year for a deadline in a later calendar year", async () => {
    const nextYear = `${new Date().getFullYear() + 1}-06-02`
    render(
      <TooltipProvider delay={0}>
        <DateTooltip value={nextYear} label="Due" variant="deadline" />
      </TooltipProvider>,
    )

    const trigger = screen.getByText(fmtDeadlineDate(nextYear))
    expect(trigger).toHaveTextContent(/, \d{4}$/)

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        fmtLabeledDeadlineDate(nextYear, "Due"),
      )
    }, { timeout: 250 })
  })
})
