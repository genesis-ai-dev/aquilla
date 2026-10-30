// AQU-2260 (Sam, Oct 29): an example is a labelled button; clicking it puts
// its whole prompt in the box, so it says nothing on hover.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { DescribeStep } from "./DescribeStep"

describe("DescribeStep examples", () => {
  it("shows nothing on hover of an example, and puts its prompt in the box on click", async () => {
    const onChange = vi.fn()
    renderWithTooltips(
      <DescribeStep value="" onChange={onChange} where="auto" onWhereChange={vi.fn()} onBuild={vi.fn()} disabled={false} />,
    )
    const user = userEvent.setup()
    const example = screen.getByRole("button", { name: /Word count panel/ })
    await user.hover(example)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("tooltip")).toBeNull()
    await user.click(example)
    expect(onChange).toHaveBeenCalledWith("A side panel with each verse's word count, updating as I type")
  })
})
