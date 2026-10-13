import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ROLE } from "@/lib/frontier/roles"
import {
  SectionVisibilityBadge,
  SectionVisibilityGate,
  visibilityFloorLabel,
  isRestrictedFloor,
  sectionTintClass,
} from "./SectionVisibilityBadge"

afterEach(() => vi.restoreAllMocks())

describe("visibilityFloorLabel", () => {
  it("labels the everyone floor distinctly from restricted floors", () => {
    expect(visibilityFloorLabel(ROLE.VIEWER)).toMatch(/everyone/i)
    expect(visibilityFloorLabel(ROLE.MAINTAINER)).toMatch(/maintainers/i)
    expect(visibilityFloorLabel(ROLE.OWNER)).toMatch(/owners/i)
  })
})

describe("isRestrictedFloor / sectionTintClass", () => {
  it("treats the viewer floor as unrestricted (no tint)", () => {
    expect(isRestrictedFloor(ROLE.VIEWER)).toBe(false)
    expect(sectionTintClass(ROLE.VIEWER)).toBe("")
  })

  it("treats maintainer+ floors as restricted (tinted)", () => {
    expect(isRestrictedFloor(ROLE.MAINTAINER)).toBe(true)
    expect(sectionTintClass(ROLE.MAINTAINER)).not.toBe("")
  })
})

describe("SectionVisibilityBadge", () => {
  // AQU-1771: on a section a project can make stricter, the popover says where
  // the shown setting comes from, under the picker. The badge itself only says
  // who can see the section (Sam, 2026-10-13).
  it("says the setting's origin under the picker, never on the badge", async () => {
    const onChangeMinRole = vi.fn()
    const { rerender } = render(
      <SectionVisibilityBadge minRole={ROLE.MAINTAINER} canEdit onChangeMinRole={onChangeMinRole} origin="org" orgDefaultRole={ROLE.MAINTAINER} />,
    )
    expect(screen.getByTestId("section-visibility-badge")).toHaveTextContent(/^Only maintainers & owners can see this$/)
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    expect(await screen.findByTestId("section-visibility-origin")).toHaveTextContent("Follows your org's setting.")

    rerender(
      <SectionVisibilityBadge
        minRole={ROLE.OWNER}
        canEdit
        onChangeMinRole={onChangeMinRole}
        origin="project"
        followOrgRole={ROLE.MAINTAINER}
        onFollowOrg={vi.fn()}
      />,
    )
    expect(screen.getByTestId("section-visibility-badge")).toHaveTextContent(/^Only owners can see this$/)
    expect(await screen.findByTestId("section-visibility-origin")).toHaveTextContent(
      "Stricter than your org (Maintainers and owners). Pick “Follow the org (Maintainers and owners)” to undo.",
    )
  })

  it("says nothing about origin on org-only sections", async () => {
    render(<SectionVisibilityBadge minRole={ROLE.MAINTAINER} canEdit onChangeMinRole={vi.fn()} />)
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    await screen.findByRole("combobox", { name: /who can see this section/i })
    expect(screen.queryByTestId("section-visibility-origin")).toBeNull()
  })

  // AQU-1771: a project's own value can always be cleared from the badge.
  it("offers a 'Follow the org' first option only when given one, and calls onFollowOrg", async () => {
    const onFollowOrg = vi.fn()
    const onChangeMinRole = vi.fn()
    render(
      <SectionVisibilityBadge
        minRole={ROLE.OWNER}
        canEdit
        onChangeMinRole={onChangeMinRole}
        followOrgRole={ROLE.MAINTAINER}
        onFollowOrg={onFollowOrg}
      />,
    )
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    fireEvent.click(await screen.findByRole("combobox", { name: /who can see this section/i }))
    const follow = await screen.findByRole("option", { name: "Follow the org (Maintainers and owners)" })
    fireEvent.pointerMove(follow)
    fireEvent.mouseMove(follow)
    fireEvent.keyDown(follow, { key: "Enter" })
    await waitFor(() => expect(onFollowOrg).toHaveBeenCalledOnce())
    expect(onChangeMinRole).not.toHaveBeenCalled()
  })

  it("renders a plain, non-interactive badge when the caller cannot edit", () => {
    render(<SectionVisibilityBadge minRole={ROLE.MAINTAINER} />)
    const badge = screen.getByTestId("section-visibility-badge")
    expect(badge).toHaveTextContent(/maintainers & owners/i)
    // No chevron / popover affordance for a read-only badge.
    expect(badge.querySelector("svg")).toBeTruthy()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("exposes an inline advanced picker when the caller can edit, and calls back with the new floor", async () => {
    const onChangeMinRole = vi.fn(async () => {})
    render(
      <SectionVisibilityBadge
        minRole={ROLE.MAINTAINER}
        canEdit
        onChangeMinRole={onChangeMinRole}
      />,
    )
    fireEvent.click(screen.getByTestId("section-visibility-badge"))

    const trigger = await screen.findByRole("combobox", { name: /who can see this section/i })
    fireEvent.click(trigger)

    const option = await screen.findByRole("option", { name: /everyone with access/i })
    fireEvent.pointerMove(option)
    fireEvent.mouseMove(option)
    fireEvent.keyDown(option, { key: "Enter" })

    await waitFor(() => expect(onChangeMinRole).toHaveBeenCalledWith(ROLE.VIEWER))
  })

  // AQU-1779: a floor the caller can't apply is disabled, explained, and never
  // reaches onChangeMinRole.
  it("disables options below minSelectableRole, shows the hint, and never calls back for them", async () => {
    const onChangeMinRole = vi.fn(async () => {})
    render(
      <SectionVisibilityBadge
        minRole={ROLE.MAINTAINER}
        canEdit
        onChangeMinRole={onChangeMinRole}
        minSelectableRole={ROLE.PROJECT_LEAD}
        belowMinSelectableHint="Lower the other setting first."
      />,
    )
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    fireEvent.click(await screen.findByRole("combobox", { name: /who can see this section/i }))

    const everyone = await screen.findByRole("option", { name: /everyone with access/i })
    expect(everyone).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("option", { name: /contributors and up/i })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("option", { name: /project leads and up/i })).not.toHaveAttribute("aria-disabled", "true")

    fireEvent.pointerMove(everyone)
    fireEvent.mouseMove(everyone)
    fireEvent.keyDown(everyone, { key: "Enter" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onChangeMinRole).not.toHaveBeenCalled()

    const lead = screen.getByRole("option", { name: /project leads and up/i })
    fireEvent.pointerMove(lead)
    fireEvent.mouseMove(lead)
    fireEvent.keyDown(lead, { key: "Enter" })
    await waitFor(() => expect(onChangeMinRole).toHaveBeenCalledWith(ROLE.PROJECT_LEAD))
  })

  it("keeps the why behind a circled-i that expands and collapses it", async () => {
    render(
      <SectionVisibilityBadge
        minRole={ROLE.MAINTAINER}
        canEdit
        onChangeMinRole={vi.fn()}
        minSelectableRole={ROLE.PROJECT_LEAD}
        belowMinSelectableHint="Lower the other setting first."
      />,
    )
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    const info = await screen.findByRole("button", { name: /why some options are unavailable/i })
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveAttribute("data-state", "closed")

    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveAttribute("data-state", "open")
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent("Lower the other setting first.")

    fireEvent.click(info)
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveAttribute("data-state", "closed")
  })

  it("shows no hint when every option is selectable", async () => {
    render(
      <SectionVisibilityBadge
        minRole={ROLE.MAINTAINER}
        canEdit
        onChangeMinRole={vi.fn()}
        minSelectableRole={ROLE.VIEWER}
        belowMinSelectableHint="Lower the other setting first."
      />,
    )
    fireEvent.click(screen.getByTestId("section-visibility-badge"))
    await screen.findByRole("combobox", { name: /who can see this section/i })
    expect(screen.queryByRole("button", { name: /why some options are unavailable/i })).not.toBeInTheDocument()
  })
})

describe("SectionVisibilityGate", () => {
  it("renders nothing (no placeholder) for a below-floor viewer", () => {
    render(
      <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={ROLE.CONTRIBUTOR}>
        <div data-testid="secret">secret section</div>
      </SectionVisibilityGate>,
    )
    expect(screen.queryByTestId("secret")).not.toBeInTheDocument()
  })

  it("renders children for a viewer meeting the floor", () => {
    render(
      <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={ROLE.OWNER}>
        <div data-testid="secret">secret section</div>
      </SectionVisibilityGate>,
    )
    expect(screen.getByTestId("secret")).toBeInTheDocument()
  })

  it("renders nothing while not-yet-ready even if the viewer role would pass", () => {
    render(
      <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={ROLE.OWNER} ready={false}>
        <div data-testid="secret">secret section</div>
      </SectionVisibilityGate>,
    )
    expect(screen.queryByTestId("secret")).not.toBeInTheDocument()
  })

  it("renders nothing when the viewer role is unknown (null)", () => {
    render(
      <SectionVisibilityGate minRole={ROLE.MAINTAINER} viewerRoleLevel={null}>
        <div data-testid="secret">secret section</div>
      </SectionVisibilityGate>,
    )
    expect(screen.queryByTestId("secret")).not.toBeInTheDocument()
  })
})
