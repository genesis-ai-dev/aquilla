import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ValidatedBar } from "./ValidatedBar"

describe("ValidatedBar (AQU-1493)", () => {
  it("never rounds a project with work left up to 100%", () => {
    render(<ValidatedBar fraction={1207 / 1208} />)
    expect(screen.getByText("99%")).toBeInTheDocument()
  })

  it("reads 100% only when everything is validated", () => {
    render(<ValidatedBar fraction={1} />)
    expect(screen.getByText("100%")).toBeInTheDocument()
  })
})
