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
