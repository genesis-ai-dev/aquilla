import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AccessModelLegend } from "./AccessModelLegend"
import { sourceInfo } from "./MembersMatrixView"

describe("AccessModelLegend", () => {
  it("shows toggle button with correct aria-expanded=false when closed", () => {
    render(<AccessModelLegend open={false} onToggle={() => {}} />)
    const btn = screen.getByRole("button", { name: /access model legend/i })
    expect(btn).toHaveAttribute("aria-expanded", "false")
  })

  it("shows legend body when open=true", () => {
    render(<AccessModelLegend open={true} onToggle={() => {}} />)
    expect(screen.getByText("Direct")).toBeInTheDocument()
    expect(screen.getByText("Via group")).toBeInTheDocument()
    expect(screen.getByText("Org-wide")).toBeInTheDocument()
    expect(screen.getByText("Creator")).toBeInTheDocument()
    expect(screen.getByText(/effective role = max-wins/i)).toBeInTheDocument()
  })

  it("hides legend body when open=false", () => {
    render(<AccessModelLegend open={false} onToggle={() => {}} />)
    expect(screen.queryByText("Direct")).not.toBeInTheDocument()
  })

  it("calls onToggle when button is clicked", () => {
    let called = false
    render(<AccessModelLegend open={false} onToggle={() => { called = true }} />)
    fireEvent.click(screen.getByRole("button", { name: /access model legend/i }))
    expect(called).toBe(true)
  })
})

describe("sourceInfo", () => {
  it("maps override → direct / D", () => {
    expect(sourceInfo("override")).toEqual({ label: "direct", badge: "D" })
  })
  it("maps org → org-wide / O (not 'via org')", () => {
    const { label } = sourceInfo("org")
    expect(label).toBe("org-wide")
    expect(sourceInfo("org").badge).toBe("O")
  })
  it("maps group → via group / G", () => {
    expect(sourceInfo("group")).toEqual({ label: "via group", badge: "G" })
  })
  it("maps creator → creator / C", () => {
    expect(sourceInfo("creator")).toEqual({ label: "creator", badge: "C" })
  })
  it("returns empty strings for unknown source", () => {
    expect(sourceInfo("unknown")).toEqual({ label: "", badge: "" })
  })
})
