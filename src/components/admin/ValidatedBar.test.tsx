import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ValidatedBar } from "./ValidatedBar"

describe("ValidatedBar (AQU-1493)", () => {
  it("never rounds a project with work left up to 100%", () => {
    const { container } = render(<ValidatedBar fraction={1207 / 1208} />)
    expect(screen.getByText("99%")).toBeInTheDocument()
    // Nor paints it the "done" green, which is what the eye reads first.
    const fill = container.querySelector("[aria-hidden]")!
    expect(fill.className).not.toContain("bg-emerald-500")
    expect((fill as HTMLElement).style.width).toBe("99%")
  })

  it("reads 100% only when everything is validated", () => {
    const { container } = render(<ValidatedBar fraction={1} />)
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(container.querySelector("[aria-hidden]")!.className).toContain("bg-emerald-500")
  })
})
