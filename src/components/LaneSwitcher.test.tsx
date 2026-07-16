// AQU-538 (slice 2): LaneSwitcher render behaviour.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LaneSwitcher } from "./LaneSwitcher"

describe("LaneSwitcher (AQU-538)", () => {
  it("renders NOTHING with a single (default) lane — N=1 header is unchanged", () => {
    const { container } = render(
      <LaneSwitcher lanes={[""]} value="" onChange={() => {}} defaultLaneLabel="Spanish" />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId("lane-switcher")).toBeNull()
  })

  it("renders an option per lane once a second lane exists", () => {
    render(
      <LaneSwitcher lanes={["", "es"]} value="" onChange={() => {}} defaultLaneLabel="English" />,
    )
    expect(screen.getByTestId("lane-switcher")).toBeInTheDocument()
    // Default lane's option carries the empty tag; its label is the target name.
    const defaultOption = screen.getByTestId("lane-option-")
    expect(defaultOption).toHaveTextContent("English")
    expect(defaultOption).toHaveAttribute("aria-checked", "true")
    // Non-default lane renders its own tag as the option + testid.
    const esOption = screen.getByTestId("lane-option-es")
    expect(esOption).toHaveTextContent("es")
    expect(esOption).toHaveAttribute("aria-checked", "false")
  })

  it("reports the chosen lane through onChange", () => {
    const onChange = vi.fn()
    render(
      <LaneSwitcher lanes={["", "es"]} value="" onChange={onChange} defaultLaneLabel="English" />,
    )
    fireEvent.click(screen.getByTestId("lane-option-es"))
    expect(onChange).toHaveBeenCalledWith("es")
  })
})
