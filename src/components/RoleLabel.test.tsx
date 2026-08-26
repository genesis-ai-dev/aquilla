import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { RoleLabel } from "./RoleLabel"
import { ROLE } from "@/lib/frontier/roles"

describe("RoleLabel", () => {
  it("renders a muted grey badge for every role", () => {
    const { rerender } = render(<RoleLabel name="contributor" />)
    const contributor = screen.getByText("Contributor")
    expect(contributor).toHaveAttribute("data-slot", "badge")
    expect(contributor).toHaveClass("bg-muted", "text-muted-foreground")
    expect(contributor).not.toHaveClass("bg-sky-50")

    rerender(<RoleLabel name={ROLE.MAINTAINER} />)
    expect(screen.getByText("Maintainer")).toHaveClass("bg-muted", "text-muted-foreground")
    expect(screen.getByText("Maintainer")).not.toHaveClass("bg-sky-50")

    rerender(<RoleLabel name="owner" />)
    expect(screen.getByText("Owner")).toHaveClass("bg-muted", "text-muted-foreground")
    expect(screen.getByText("Owner")).not.toHaveClass("bg-sky-50")
  })

  it("skips badge chrome when plain", () => {
    render(<RoleLabel name="viewer" plain />)
    const label = screen.getByText("Viewer")
    expect(label).not.toHaveAttribute("data-slot", "badge")
    expect(label.tagName).toBe("SPAN")
  })

  it("title-cases each word, including multi-word roles", () => {
    render(<RoleLabel name="project_lead" />)
    expect(screen.getByText("Project lead")).toHaveClass("capitalize")
  })
})
