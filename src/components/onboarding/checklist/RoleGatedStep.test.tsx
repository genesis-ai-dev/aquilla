import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { RoleGatedStep } from "./RoleGatedStep"
import { ROLE } from "@/lib/frontier/roles"

// RoleGatedStep's job is computing the right role-naming string and gating
// attributes — not exercising Base UI's async hover-open mechanics (that's
// Base UI's own concern). Render AppTooltip's content unconditionally so this
// test asserts against RoleGatedStep's own logic, not tooltip open/close timing.
vi.mock("@/components/ui/tooltip", () => ({
  AppTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </>
  ),
}))

// AQU-334: Project Setup sidebar rows must render read-only (grayed +
// tooltip naming the required role) for below-floor callers, never hidden
// and never fronted by a 403 as the primary signal — per
// aquilla-specs/05-user-stories/customize-ai-settings.md Persona section.
describe("RoleGatedStep", () => {
  it("renders children normally when the caller's role meets the floor", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.MAINTAINER} requiredRole={ROLE.MAINTAINER} actionLabel="Editing translation instructions">
        <button>Save instructions</button>
      </RoleGatedStep>,
    )
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeInTheDocument()
    expect(document.querySelector("[aria-disabled='true']")).toBeNull()
  })

  it("renders children normally when the caller's role exceeds the floor", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.OWNER} requiredRole={ROLE.PROJECT_LEAD} actionLabel="Inviting collaborators">
        <button>Add</button>
      </RoleGatedStep>,
    )
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
    expect(document.querySelector("[aria-disabled='true']")).toBeNull()
  })

  it("treats a null (unsynced project) role as allowed — no server floor to gate against", () => {
    render(
      <RoleGatedStep roleLevel={null} requiredRole={ROLE.MAINTAINER} actionLabel="Editing translation instructions">
        <button>Save instructions</button>
      </RoleGatedStep>,
    )
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeInTheDocument()
    expect(document.querySelector("[aria-disabled='true']")).toBeNull()
  })

  it("renders below-floor callers read-only with aria-disabled and a role-naming tooltip, without hiding the content", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.CONTRIBUTOR} requiredRole={ROLE.MAINTAINER} actionLabel="Editing translation instructions">
        <button>Save instructions</button>
      </RoleGatedStep>,
    )
    // Content stays visible (never hidden) — the "don't hide, gray out" rule.
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeInTheDocument()
    expect(screen.getByTestId("role-gated-step")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(/maintainer/i)
  })

  it("names project_lead as the required role for the invite floor", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.CONTRIBUTOR} requiredRole={ROLE.PROJECT_LEAD} actionLabel="Inviting collaborators">
        <button>Add</button>
      </RoleGatedStep>,
    )
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(/project_lead/i)
  })

  it("blocks a contributor (400) from the project_lead (500) invite floor", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.CONTRIBUTOR} requiredRole={ROLE.PROJECT_LEAD} actionLabel="Inviting collaborators">
        <button>Add</button>
      </RoleGatedStep>,
    )
    expect(document.querySelector("[aria-disabled='true']")).toBeTruthy()
  })

  it("allows a project_lead (500) through the invite floor", () => {
    render(
      <RoleGatedStep roleLevel={ROLE.PROJECT_LEAD} requiredRole={ROLE.PROJECT_LEAD} actionLabel="Inviting collaborators">
        <button>Add</button>
      </RoleGatedStep>,
    )
    expect(document.querySelector("[aria-disabled='true']")).toBeNull()
  })
})
