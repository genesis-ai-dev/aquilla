// AQU-214: InactiveProjectBanner component tests.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { InactiveProjectBanner } from "./InactiveProjectBanner"

describe("InactiveProjectBanner", () => {
  it("renders the project name and frozen message", () => {
    render(
      <InactiveProjectBanner
        projectName="Bambara NT"
        canReactivate={false}
        onReactivate={() => {}}
      />,
    )
    expect(screen.getByText("Bambara NT", { exact: false })).toBeDefined()
    expect(screen.getByText(/inactive/i, { exact: false })).toBeDefined()
  })

  it("shows Reactivate button when canReactivate is true", () => {
    render(
      <InactiveProjectBanner
        projectName="Project"
        canReactivate={true}
        onReactivate={() => {}}
      />,
    )
    expect(screen.getByTestId("reactivate-button")).toBeDefined()
  })

  it("hides Reactivate button when canReactivate is false (viewer)", () => {
    render(
      <InactiveProjectBanner
        projectName="Project"
        canReactivate={false}
        onReactivate={() => {}}
      />,
    )
    expect(screen.queryByTestId("reactivate-button")).toBeNull()
  })

  it("calls onReactivate when Reactivate button is clicked", () => {
    const onReactivate = vi.fn()
    render(
      <InactiveProjectBanner
        projectName="Project"
        canReactivate={true}
        onReactivate={onReactivate}
      />,
    )
    fireEvent.click(screen.getByTestId("reactivate-button"))
    expect(onReactivate).toHaveBeenCalledOnce()
  })

  it("disables the button and shows Reactivating… while busy", () => {
    render(
      <InactiveProjectBanner
        projectName="Project"
        canReactivate={true}
        onReactivate={() => {}}
        busy={true}
      />,
    )
    const btn = screen.getByTestId("reactivate-button") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain("Reactivating")
  })
})
