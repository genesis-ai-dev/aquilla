import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { InFlowVersionProvider, VersionBadge, VersionTag } from "./VersionBadge"

/**
 * The floating <VersionBadge/> exists for pages with no chrome. Wherever a page
 * renders its own in-flow version line (the AppShell rail footer, an auth-page
 * footer), the floating one must disappear — otherwise it stacks on the rail
 * footer and covers the account switcher, Help and localization. The decision is
 * driven by what is mounted, not by a route list, so a page that adopts AppShell
 * without anyone remembering a list (the Paratext bridge pages did) still works.
 */
function renderApp(page: React.ReactNode, { withProvider = true } = {}) {
  const tree = (
    <>
      {page}
      <VersionBadge />
    </>
  )
  return render(
    <MemoryRouter initialEntries={["/paratext"]}>
      <I18nProvider>
        {withProvider ? <InFlowVersionProvider>{tree}</InFlowVersionProvider> : tree}
      </I18nProvider>
    </MemoryRouter>,
  )
}

const copyButtons = () => screen.getAllByRole("button", { name: "Copy build info" })

describe("floating VersionBadge", () => {
  it("shows on a page with no in-flow version line", () => {
    renderApp(null)
    expect(copyButtons()).toHaveLength(1)
  })

  it("stands down while a rail VersionTag is mounted, whatever the route", () => {
    renderApp(<VersionTag />)
    // Only the rail's own copy button remains.
    expect(copyButtons()).toHaveLength(1)
    expect(screen.queryByText(/^v\d/, { selector: "span.max-w-\\[min\\(70vw\\,24rem\\)\\]" })).toBeNull()
  })

  it("stands down while an inline auth-footer badge is mounted", () => {
    renderApp(<VersionBadge inline />)
    expect(copyButtons()).toHaveLength(1)
  })

  it("comes back once the in-flow line unmounts", () => {
    const { rerender } = renderApp(<VersionTag />)
    expect(copyButtons()).toHaveLength(1)
    rerender(
      <MemoryRouter initialEntries={["/paratext"]}>
        <I18nProvider>
          <InFlowVersionProvider>
            <VersionBadge />
          </InFlowVersionProvider>
        </I18nProvider>
      </MemoryRouter>,
    )
    expect(copyButtons()).toHaveLength(1)
    expect(document.querySelector(".fixed.bottom-3")).not.toBeNull()
  })

  it("renders without a provider (standalone tests of VersionTag)", () => {
    renderApp(<VersionTag />, { withProvider: false })
    expect(copyButtons()).toHaveLength(2)
  })
})
