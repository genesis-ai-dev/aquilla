import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { formatScopePath } from "@/lib/access/scope-path"
import type { ScopePath } from "@/lib/access/types"
import { useT } from "@/lib/i18n/I18nProvider"

import { ScopeBreadcrumb, ScopeGrantChip } from "./ScopeBreadcrumb"

const org = { type: "org" as const, id: "o1", name: "Org" }
const project = { type: "project" as const, id: "p1", name: "Alpha" }
const lane = { type: "lane" as const, id: "fr", name: "French" }
const team = { type: "team" as const, id: "t1", name: "Blue" }

function Surfaces({ path }: { path: ScopePath }) {
  const t = useT()
  const scope = formatScopePath(path)
  return (
    <>
      <h1 data-testid="page-title"><ScopeBreadcrumb path={path} /></h1>
      <h2 data-testid="dialog-title">{t("org.access.addPeopleTo", { path: scope })}</h2>
      <ScopeGrantChip path={path} />
    </>
  )
}

describe("one scope string (AQU-2361)", () => {
  it.each([
    ["org", [org] as ScopePath],
    ["project", [org, project] as ScopePath],
    ["lane", [org, project, lane] as ScopePath],
  ])("page title, add-people header and grant chip match at %s scope", (_name, path) => {
    const { unmount } = render(<Surfaces path={path} />)
    const title = screen.getByTestId("page-title").textContent
    const scope = formatScopePath(path)
    expect(title).toBe(scope)
    expect(screen.getByTestId("dialog-title").textContent).toBe(`Add people to ${scope}`)
    expect(screen.getByTestId("scope-grant-scope").textContent).toBe(scope)
    expect(Buffer.from(title ?? "", "utf8").equals(Buffer.from(scope, "utf8"))).toBe(true)
    expect(Buffer.from(screen.getByTestId("scope-grant-scope").textContent ?? "", "utf8").equals(Buffer.from(scope, "utf8"))).toBe(true)
    unmount()
  })

  it("shows a grant through a team as a chip beside the scope, not as a crumb", () => {
    const path: ScopePath = [org, team, project, lane]
    render(<Surfaces path={path} />)
    const scope = "Org › Alpha › French"
    expect(formatScopePath(path)).toBe(scope)
    expect(screen.getByTestId("page-title").textContent).toBe(scope)
    expect(screen.getByTestId("dialog-title").textContent).toBe(`Add people to ${scope}`)
    expect(screen.getByTestId("scope-grant-scope").textContent).toBe(scope)
    expect(screen.getByTestId("scope-via-team").textContent).toBe(" · via team Blue")
    expect(screen.getByTestId("scope-grant-chip").textContent).toBe(`${scope} · via team Blue`)
    expect(screen.getByTestId("page-title").textContent).not.toContain("Blue")
  })
})
