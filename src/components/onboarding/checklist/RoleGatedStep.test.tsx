import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { expectDisabledNote } from "@/test-utils/tooltip"
import { RoleGatedStep } from "./RoleGatedStep"
import { ROLE } from "@/lib/frontier/roles"

// AQU-2260 (Sam, Oct 29): the reason is a note that opens on CLICK of the
// greyed step, never a hover. Nothing to mock: a click is synchronous to
// drive, which a hover-open never was.
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

  it("renders below-floor callers read-only with aria-disabled and a role-naming note on click, without hiding the content", async () => {
    render(
      <RoleGatedStep roleLevel={ROLE.CONTRIBUTOR} requiredRole={ROLE.MAINTAINER} actionLabel="Editing translation instructions">
        <button>Save instructions</button>
      </RoleGatedStep>,
    )
    // Content stays visible (never hidden) — the "don't hide, gray out" rule.
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeInTheDocument()
    // Read-only for the keyboard too, not only for the pointer.
    expect(screen.getByRole("button", { name: "Save instructions" })).toBeDisabled()
    expect(screen.getByTestId("role-gated-step")).toHaveAttribute("aria-disabled", "true")
    // The reason opens on click of the greyed step; hover shows nothing.
    await expectDisabledNote(screen.getByTestId("role-gated-step"), /maintainer/i)
  })

  it("names project_lead as the required role for the invite floor", async () => {
    render(
      <RoleGatedStep roleLevel={ROLE.CONTRIBUTOR} requiredRole={ROLE.PROJECT_LEAD} actionLabel="Inviting collaborators">
        <button>Add</button>
      </RoleGatedStep>,
    )
    await expectDisabledNote(screen.getByTestId("role-gated-step"), /Project Lead/i)
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
