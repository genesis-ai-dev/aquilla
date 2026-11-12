import { describe, it, expect, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { useState } from "react"
import { CheckingScopePicker } from "./CheckingScopePicker"
afterEach(cleanup)
function Harness() {
  const [selected, setSelected] = useState(new Set<string>())
  return <CheckingScopePicker files={[{ fileId: "a", name: "Genesis", units: [
    { cellId: "1", label: "GEN 1:1", section: "GEN 1" },
    { cellId: "2", label: "GEN 1:2", section: "GEN 1" },
  ] }]} selected={selected} onChange={setSelected} />
}
describe("checking hierarchy", () => {
  it("selects a whole project, then reflects a single-unit deselection in its parents", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("checkbox", { name: "Whole project" }))
    expect(screen.getByRole("checkbox", { name: "Genesis" })).toBeChecked()
    fireEvent.click(screen.getByText("GEN 1", { selector: "summary" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "GEN 1:1" }))
    expect(screen.getByRole("checkbox", { name: "Whole project" })).toHaveAttribute("aria-checked", "mixed")
    expect(screen.getByRole("checkbox", { name: "Genesis" })).toHaveAttribute("aria-checked", "mixed")
    expect(screen.getByRole("checkbox", { name: "GEN 1:2" })).toBeChecked()
  })
})
