import "@/test-utils/all-catalogs"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RoleLabel } from "./RoleLabel"
import { ROLE } from "@/lib/frontier/roles"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import { shownCase } from "@/test-utils/shown-case"

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

  // AQU-2332: the chip's CSS `capitalize` turned the catalog's "Project lead"
  // into "Project Lead" on screen. It shows the catalog's name as written, in
  // sentence case and in the reader's language, like the role dialog (AQU-2289).
  describe("the role's name", () => {
    afterEach(() => window.localStorage.clear())

    it("is the catalog's sentence-case name, as a chip and plain", () => {
      const { rerender } = render(<RoleLabel name="project_lead" />)
      expect(shownCase(screen.getByText("Project lead"))).toBe("as written")
      rerender(<RoleLabel name={ROLE.PROJECT_LEAD} plain />)
      expect(shownCase(screen.getByText("Project lead"))).toBe("as written")
    })

    it("is in the reader's language", () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr")
      render(
        <I18nProvider>
          <RoleLabel name={ROLE.PROJECT_LEAD} />
        </I18nProvider>,
      )
      expect(shownCase(screen.getByText("Chef de projet"))).toBe("as written")
    })
  })
})
