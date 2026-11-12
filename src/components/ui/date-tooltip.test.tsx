import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DateTooltip } from "./date-tooltip"
import { TooltipProvider } from "@/components/ui/tooltip"
import { fmtDeadlineDate, fmtLabeledDeadlineDate, fmtLabeledDateTime, fmtShortCalendarDate } from "@/lib/format-date"

const EDITED_AT = new Date(2026, 6, 3, 13, 37, 8).getTime()

describe("DateTooltip", () => {
  // AQU-1916: every case here mounts the provider with delay={0}, and the
  // hover cases used a real 250 ms window to assert the tooltip opened
  // "promptly" — which let machine speed decide correctness. On a fake clock
  // the claim is exact: the tooltip is open once no logical time has passed.
  // Only setTimeout/clearTimeout are faked, which is all Base UI's open delay
  // uses; everything else stays real.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }) })
  afterEach(() => { vi.useRealTimers() })

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

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      fmtLabeledDateTime(EDITED_AT, "Edited"),
    )
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

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      fmtLabeledDateTime(tenDaysAgo, "Posted"),
    )
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
    if (!trigger) throw new Error("edited time is not inside a tooltip trigger")

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const tip = screen.getByRole("tooltip")
    expect(tip).toHaveTextContent(/^Created:/)
    expect(tip).toHaveTextContent(/Edited:/)
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

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      fmtLabeledDeadlineDate(nextYear, "Due"),
    )
  })
})
