/**
 * AQU-2317 (AQU-1352 design board 2): the two primitives every later Access
 * slice reuses. The ladder must read as a ladder (one rung per level, never a
 * number), shape must say where a grant comes from, and a place must read the
 * same wherever it is drawn.
 */
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { accessNodeHref, accessNodeId } from "@/components/org/access/access-anchors"
import { ROLE_RUNGS } from "@/lib/access/role-scale"
import { formatScopePath } from "@/lib/access/scope-path"
import type { ScopePath } from "@/lib/access/types"
import { ALL_ROLE_LEVELS } from "@/lib/frontier/roles"

import { PlaceBreadcrumb } from "./PlaceBreadcrumb"
import { RoleBadge } from "./RoleBadge"

const org = { type: "org" as const, id: "o1", name: "Biblica ETT" }
const team = { type: "team" as const, id: "t1", name: "biblica/pattani-malay" }
const project = { type: "project" as const, id: "p1", name: "Pattani Malay Bible" }
const lane = { type: "lane" as const, id: "l1", name: "Pattani Malay" }
const teamPath: ScopePath = [org, team]
// What the server sends a guest who may not see the ancestors (§3.9 rule 4).
const hiddenOrg = { type: "org" as const, id: "o1", name: "", hidden: true as const }

const badge = () => screen.getByTestId("role-badge")

describe("RoleBadge — the role ladder", () => {
  it("maps every level to its label and its rung, never to a number", () => {
    const labels = ["Viewer", "Commenter", "Reviewer", "Contributor", "Project Lead", "Maintainer", "Owner"]
    ALL_ROLE_LEVELS.forEach((level, i) => {
      const { unmount } = render(<RoleBadge roleLevel={level} origin={{ kind: "direct" }} />)
      expect(badge().textContent).toBe(labels[i])
      expect(badge().getAttribute("data-role-rung")).toBe(String(i + 1))
      expect(badge().className).toContain(`role-rung-${i + 1}`)
      expect(badge().textContent).not.toMatch(/\d/)
      unmount()
    })
    expect(labels).toHaveLength(ROLE_RUNGS.length)
  })

  it("renders no access and an off-ladder level without inventing a rung", () => {
    const { unmount } = render(<RoleBadge roleLevel={null} origin={{ kind: "direct" }} />)
    expect(badge().textContent).toBe("No access")
    expect(badge().getAttribute("data-role-rung")).toBeNull()
    unmount()
    render(<RoleBadge roleLevel={250} origin={{ kind: "direct" }} />)
    expect(badge().textContent).toBe("Unknown role")
    expect(badge().getAttribute("data-role-rung")).toBeNull()
  })

  it("draws a direct grant as a solid pill with no source place", () => {
    render(<RoleBadge roleLevel={400} origin={{ kind: "direct" }} />)
    expect(badge().textContent).toBe("Contributor")
    expect(badge().className).toContain("role-rung-4")
    expect(badge().className).not.toContain("border-dashed")
    expect(badge().getAttribute("data-origin")).toBe("direct")
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("draws an inherited grant as a dashed pill naming its place, linked to it", () => {
    render(<RoleBadge roleLevel={400} origin={{ kind: "inherited", from: teamPath }} hrefFor={accessNodeHref} />)
    expect(badge().textContent).toBe(`Contributor · via ${formatScopePath(teamPath)}`)
    expect(badge().className).toContain("border-dashed")
    expect(badge().className).toContain("role-rung-4-edge")
    // The rung lives in the dashed edge here; the ink stays the theme's own pair.
    expect(badge().className).not.toMatch(/role-rung-4(?!-edge)/)
    expect(badge().getAttribute("data-origin")).toBe("inherited")
    // Lands on the innermost place the grant is set at, in the page's tree.
    expect(screen.getByRole("link")).toHaveAttribute("href", `#${accessNodeId(team)}`)
    expect(badge().querySelector("svg")).not.toBeNull()
  })

  it("gives an inherited grant no link when its place is hidden from the viewer", () => {
    render(<RoleBadge roleLevel={600} origin={{ kind: "inherited", from: [hiddenOrg] }} hrefFor={accessNodeHref} />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(badge().className).toContain("border-dashed")
    expect(badge().textContent).toBe("Maintainer · via …")
  })

  it("spells out creator and platform, which are not places you can open", () => {
    const { unmount } = render(<RoleBadge roleLevel={700} origin={{ kind: "creator" }} />)
    expect(badge().textContent).toBe("Owner · Creator")
    expect(badge().className).toContain("role-rung-7")
    unmount()
    render(<RoleBadge roleLevel={700} origin={{ kind: "platform" }} />)
    expect(badge().textContent).toBe("Owner · Platform admin")
    expect(badge().className).not.toContain("border-dashed")
  })
})

describe("PlaceBreadcrumb", () => {
  it.each([
    ["1 deep", [org] as ScopePath],
    ["2 deep", [org, team] as ScopePath],
    ["3 deep", [org, team, project] as ScopePath],
    ["4 deep", [org, team, project, lane] as ScopePath],
  ])("reads byte-identical to formatScopePath, %s", (_name, path) => {
    const { container } = render(<PlaceBreadcrumb path={path} />)
    expect(container.textContent).toBe(formatScopePath(path))
  })

  it("carries one icon per kind of place", () => {
    const { container } = render(<PlaceBreadcrumb path={[org, team, project, lane]} />)
    expect([...container.querySelectorAll("[data-place-icon]")].map((n) => n.getAttribute("data-place-icon")))
      .toEqual(["org", "team", "project", "lane"])
  })

  it("links ancestors but not the place itself", () => {
    render(<PlaceBreadcrumb path={[org, team, project]} hrefFor={accessNodeHref} />)
    expect(screen.getByRole("link", { name: org.name })).toHaveAttribute("href", `#${accessNodeId(org)}`)
    expect(screen.queryByRole("link", { name: project.name })).toBeNull()
  })

  it("collapses ancestors the viewer cannot see into one ellipsis crumb", () => {
    const { container } = render(<PlaceBreadcrumb path={[hiddenOrg, project]} />)
    expect(container.textContent).toBe(`… › ${project.name}`)
    expect(screen.getByTestId("place-hidden-ancestors")).toBeTruthy()
  })
})
