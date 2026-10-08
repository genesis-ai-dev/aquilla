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
    expect(screen.getByTestId("section-visibility-min-hint")).toHaveTextContent("Lower the other setting first.")

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
    expect(screen.queryByTestId("section-visibility-min-hint")).not.toBeInTheDocument()
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
