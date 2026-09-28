import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { formatScopePath } from "@/lib/access/scope-path"
import type { MemberAccess, ScopePath } from "@/lib/access/types"
import { ROLE } from "@/lib/frontier/roles"

import { EffectiveRoleCell } from "./EffectiveRoleCell"
import { GrantOriginBadge } from "./GrantOriginBadge"
import { InheritedRoleControl } from "./InheritedRoleControl"
import { MemberInspector } from "./MemberInspector"
import { ScopeBreadcrumb } from "./ScopeBreadcrumb"

// AQU-1352 spec §3.7–3.9 fixtures: Naladda, a guest of Biblica ETT.
const org = { type: "org" as const, id: "o1", name: "Biblica ETT" }
const team = { type: "team" as const, id: "t1", name: "biblica/pattani-malay" }
const project = { type: "project" as const, id: "p1", name: "Pattani Malay Bible" }
const teamPath: ScopePath = [org, team]
const projectPath: ScopePath = [org, team, project]

describe("ScopeBreadcrumb (§3.9)", () => {
  it("renders the same text as formatScopePath so title and chips match byte for byte", () => {
    const { container } = render(<ScopeBreadcrumb path={projectPath} />)
    expect(container.textContent).toBe(formatScopePath(projectPath))
  })

  it("links ancestors but not the scope being granted at (rule 1)", () => {
    render(<ScopeBreadcrumb path={projectPath} hrefFor={(s) => `/x/${s.id}`} />)
    expect(screen.getByRole("link", { name: "Biblica ETT" })).toHaveAttribute("href", "/x/o1")
    expect(screen.queryByRole("link", { name: "Pattani Malay Bible" })).toBeNull()
  })

  it("hides ancestors a guest cannot see behind an ellipsis (rule 4)", () => {
    const { container } = render(<ScopeBreadcrumb path={projectPath} truncateBefore={2} />)
    expect(container.textContent).toBe("… › Pattani Malay Bible")
    expect(screen.queryByText("Biblica ETT")).toBeNull()
  })
})

describe("GrantOriginBadge (§3.7 rule 1)", () => {
  it.each([
    [{ kind: "direct" as const }, "Direct"],
    [{ kind: "inherited" as const, from: teamPath }, "Inherited · Biblica ETT › biblica/pattani-malay"],
    [{ kind: "creator" as const }, "Creator"],
    [{ kind: "platform" as const }, "Platform admin"],
  ])("labels %o as %s", (origin, text) => {
    render(<GrantOriginBadge origin={origin} />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})

describe("EffectiveRoleCell (§3.7 rule 3)", () => {
  it("shows direct and effective roles together when they differ — never one alone", () => {
    const { container } = render(
      <EffectiveRoleCell
        directRoleLevel={ROLE.CONTRIBUTOR}
        effectiveRoleLevel={ROLE.PROJECT_LEAD}
        effectiveOrigin={{ kind: "inherited", from: teamPath }}
      />,
    )
    expect(container.textContent).toBe(
      "Contributor (direct) → Project lead (via Biblica ETT › biblica/pattani-malay)",
    )
  })

  it("shows a single role when direct equals effective, and never a numeric level", () => {
    const { container } = render(
      <EffectiveRoleCell
        directRoleLevel={ROLE.CONTRIBUTOR}
        effectiveRoleLevel={ROLE.CONTRIBUTOR}
        effectiveOrigin={{ kind: "direct" }}
      />,
    )
    expect(container.textContent).toBe("Contributor")
    expect(container.textContent).not.toMatch(/\d/)
  })
})

describe("InheritedRoleControl (§3.7 rule 2)", () => {
  it("disables the control on an inherited row and says where to change it", async () => {
    render(
      <TooltipProvider>
        <InheritedRoleControl origin={{ kind: "inherited", from: teamPath }} hrefFor={(s) => `/access/${s.id}`}>
          <button type="button">Role</button>
        </InheritedRoleControl>
      </TooltipProvider>,
    )
    expect(screen.getByRole("button", { name: "Role" })).toBeDisabled()
    const path = formatScopePath(teamPath)
    expect(screen.getByRole("link", { name: `Change at ${path}` })).toHaveAttribute("href", "/access/t1")

    const trigger = screen.getByTestId("inherited-role-control")
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(`Set at ${path} — change it there`)
    })
  })

  it("leaves direct grants editable — only inherited rows are locked", () => {
    render(
      <InheritedRoleControl origin={{ kind: "direct" }}>
        <button type="button">Role</button>
      </InheritedRoleControl>,
    )
    expect(screen.getByRole("button", { name: "Role" })).toBeEnabled()
  })
})

describe("MemberInspector (§3.8)", () => {
  const member: MemberAccess = {
    userId: "u1",
    displayName: "Naladda Silawajanakul",
    isGuest: true,
    effectiveHere: {
      roleLevel: ROLE.PROJECT_LEAD,
      chain: [
        { scopePath: teamPath, roleLevel: ROLE.PROJECT_LEAD, origin: { kind: "inherited", from: teamPath }, grantedBy: "Joel" },
        { scopePath: projectPath, roleLevel: ROLE.CONTRIBUTOR, origin: { kind: "direct" }, grantedBy: "Joel" },
      ],
    },
    elsewhere: [
      { scopePath: [org, { type: "team", id: "t2", name: "biblica/bsb" }], roleLevel: ROLE.VIEWER, origin: { kind: "direct" } },
      { scopePath: [org], roleLevel: null, origin: { kind: "direct" } },
    ],
  }

  it("renders 'Effective here' before 'Everything else' (rule 1)", () => {
    render(<MemberInspector member={member} herePath={projectPath} />)
    const sections = screen.getByTestId("member-inspector").querySelectorAll("section[data-section]")
    expect([...sections].map((s) => s.getAttribute("data-section"))).toEqual(["effective-here", "everything-else"])
    const here = within(sections[0] as HTMLElement)
    expect(here.getByText(`Effective here (${formatScopePath(projectPath)})`)).toBeInTheDocument()
    expect(here.getAllByText("Project lead").length).toBeGreaterThan(0)
  })

  it("groups everything else outermost-first and shows 'No access' rather than a number", () => {
    render(<MemberInspector member={member} herePath={projectPath} />)
    const rows = screen.getByTestId("member-inspector").querySelectorAll('section[data-section="everything-else"] li')
    expect(rows[0]).toHaveTextContent("No access")
    expect(rows[1]).toHaveTextContent("biblica/bsb")
    expect(screen.getByTestId("member-inspector").textContent).not.toMatch(/\b[1-7]00\b/)
  })

  it("labels guests in the header so org-vs-project scope is visible (rule 5, AQU-1030)", () => {
    render(<MemberInspector member={member} herePath={projectPath} />)
    expect(screen.getByTestId("inspector-guest")).toHaveTextContent("Guest of Biblica ETT")
  })

  it("is read-only: the only action is the Manage access link-out (rule 3)", () => {
    const onManage = vi.fn()
    render(<MemberInspector member={{ ...member, isGuest: false }} herePath={projectPath} onManageAccess={onManage} />)
    expect(screen.queryByTestId("inspector-guest")).toBeNull()
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onManage).toHaveBeenCalledOnce()
  })
})
