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

  it("shows a compact relative date and keeps the full datetime on hover", async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    render(
      <TooltipProvider delay={0}>
        <DateTooltip value={tenDaysAgo} label="Posted" variant="ago" />
      </TooltipProvider>,
    )

    const trigger = screen.getByText("10d ago")
    expect(trigger).toBeInTheDocument()
    expect(trigger.className).toContain("hover:text-foreground")

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        fmtLabeledDateTime(tenDaysAgo, "Posted"),
      )
    }, { timeout: 250 })
  })

  it("marks an edited time and lists when it was created and edited", async () => {
    const created = Date.now() - 21 * 60 * 60 * 1000
    const edited = created + 4 * 60 * 60 * 1000
    render(
      <TooltipProvider delay={0}>
        <DateTooltip
          value={created}
          label=""
          variant="ago"
          editedAt={edited}
          editedNotice="(edited)"
        />
      </TooltipProvider>,
    )

    const trigger = screen.getByText(/\(edited\)/).closest("[data-slot=tooltip-trigger]")
    expect(trigger).toHaveTextContent("21h ago")
    expect(trigger).toHaveTextContent("(edited)")

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      const tip = screen.getByRole("tooltip")
      expect(tip).toHaveTextContent(/^Created:/)
      expect(tip).toHaveTextContent(/Edited:/)
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
