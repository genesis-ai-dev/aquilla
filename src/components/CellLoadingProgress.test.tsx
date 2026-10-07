import { render, screen } from "@testing-library/react"
import { expect, it } from "vitest"
import { CellLoadingProgress } from "./CellLoadingProgress"

it("shows download percentage without a confusing entry count and disappears when complete", () => {
  const { rerender, container } = render(<CellLoadingProgress progress={{ loaded: 2500, total: 31215 }} />)
  expect(container.textContent).toBe(" · 8%")
  rerender(<CellLoadingProgress progress={{ loaded: 0, total: null }} />)
  expect(container).toBeEmptyDOMElement()
  rerender(<CellLoadingProgress progress={null} />)
  expect(container).toBeEmptyDOMElement()
})

it.each([
  [0, 20, "0%"],
  [10, 20, "50%"],
  [1999, 2000, "99%"],
  [20, 20, "100%"],
  [21, 20, "100%"],
])("shows %s of %s as %s without rounding unfinished work to 100%%", (loaded, total, expected) => {
  render(<CellLoadingProgress progress={{ loaded, total }} />)
  expect(screen.getByText(`· ${expected}`)).toBeInTheDocument()
})

it.each([0, null, NaN, Infinity])("keeps unknown or unusable total %s indeterminate", (total) => {
  const { container } = render(<CellLoadingProgress progress={{ loaded: 0, total }} />)
  expect(container).toBeEmptyDOMElement()
})
