// Slice 3A (Sam, Oct 29): a cut take's row says how many of its pieces are
// approved. Where the row is too narrow for "0 of 2 pieces approved", the count
// is the first thing to shorten — "0 of 2 approved", then "0/2" — so the take's
// name stays whole ("Take 12") and its length stays whole. The date beside the
// name gives way before the count does. The whole sentence stays the hover text
// and what a screen reader reads.
//
// happy-dom has no layout, so the row's widths are given here: the count
// measures its row exactly as it does in a browser, from these numbers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { PiecesApproved, pickPiecesCountForm } from "./PiecesApproved"

describe("pickPiecesCountForm", () => {
  const widths = { long: 115, short: 80, tiny: 18 }
  it("the whole sentence while it fits", () => {
    expect(pickPiecesCountForm(115, widths)).toBe("long")
    expect(pickPiecesCountForm(300, widths)).toBe("long")
  })
  it("then without \"pieces\"", () => {
    expect(pickPiecesCountForm(114, widths)).toBe("short")
    expect(pickPiecesCountForm(80, widths)).toBe("short")
  })
  it("then the fraction — and the fraction when nothing fits", () => {
    expect(pickPiecesCountForm(79, widths)).toBe("tiny")
    expect(pickPiecesCountForm(0, widths)).toBe("tiny")
  })
})

// The forms' widths in px, and the widths of what sits beside the count.
const FORM_PX: Record<string, number> = { long: 115, short: 80, tiny: 18 }
const NAME_PX = 51 // "Take 12"
const LENGTH_PX = 23 // "6.0s"
const GAP_PX = 4
/** The text and the count share this much of the row between them. */
let shared = 0

function currentFormPx(): number {
  const text = document.querySelector<HTMLElement>("[data-count-text]")
  return FORM_PX[text?.dataset.countText ?? "long"] ?? 0
}

function widthOf(el: HTMLElement): number {
  // The text takes what the count leaves it, as the row's flex layout does.
  if ("fitText" in el.dataset) return shared - currentFormPx()
  if (el.dataset.px) return Number(el.dataset.px)
  if (el.dataset.countForm) return FORM_PX[el.dataset.countForm]
  if (el.dataset.countText) return FORM_PX[el.dataset.countText]
  return 0
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widthOf(this)
  })
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widthOf(this)
  })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return widthOf(this)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const pieces = [
  { validatorCount: 0, validators: [] },
  { validatorCount: 0, validators: [] },
] as unknown as Parameters<typeof PiecesApproved>[0]["pieces"]

function Row({ withDate = true }: { withDate?: boolean }) {
  return (
    <div data-fit-row="">
      <span data-fit-text="" style={{ columnGap: `${GAP_PX}px` }}>
        <span data-px={NAME_PX}>Take 12</span>
        <span data-px={LENGTH_PX}>6.0s</span>
        {withDate && <span data-fit="give" data-px={70}>October 24 · ana</span>}
      </span>
      <PiecesApproved pieces={pieces} requirement={1} testId="count" fit />
    </div>
  )
}

function drawAt(px: number, withDate = true) {
  shared = px
  return render(
    <I18nProvider>
      <Row withDate={withDate} />
    </I18nProvider>,
  )
}

const shown = () => screen.getByTestId("count").querySelector<HTMLElement>("[data-count-text]")!

describe("PiecesApproved in a narrow row", () => {
  // Name 51 + length 23 + two gaps 8 = 82 px the text needs; the date may go.
  it("says the whole sentence while the name and the length keep their room — the date gives way first", () => {
    drawAt(82 + 115 + 4 + 1)
    expect(shown()).toHaveTextContent(/^0 of 2 pieces approved$/)
    expect(screen.getByTestId("count")).toHaveAttribute("data-form", "long")
  })

  it("leaves out \"pieces\" before the name or the length give up any room", () => {
    drawAt(82 + 100)
    expect(shown()).toHaveTextContent(/^0 of 2 approved$/)
    expect(screen.getByTestId("count")).toHaveAttribute("data-form", "short")
  })

  it("then says it as a fraction", () => {
    drawAt(82 + 40)
    expect(shown()).toHaveTextContent(/^0\/2$/)
    expect(screen.getByTestId("count")).toHaveAttribute("data-form", "tiny")
  })

  it("keeps the whole sentence on hover and for a screen reader when it is short", () => {
    drawAt(82 + 40)
    const count = screen.getByTestId("count")
    expect(count).toHaveAttribute("title", "0 of 2 pieces approved")
    expect(shown()).toHaveAttribute("aria-hidden", "true")
    expect(count.querySelector(".sr-only")).toHaveTextContent(/^0 of 2 pieces approved$/)
  })

  it("is the whole sentence where it is not asked to fit", () => {
    shared = 0
    render(
      <I18nProvider>
        <PiecesApproved pieces={pieces} requirement={1} testId="count" />
      </I18nProvider>,
    )
    expect(screen.getByTestId("count")).toHaveTextContent(/^0 of 2 pieces approved$/)
  })
})
