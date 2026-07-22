// AQU-538 slice 2 — LanguagesSection component tests.
//
// `patch` is injected as a prop (it's ProjectSettings.tsx's `patchShared`,
// itself `useProjectSettings(...).patch`), so these tests exercise the
// component in isolation with a stubbed patch function rather than standing
// up the whole ProjectSettings tree or a network layer.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LanguagesSection } from "./LanguagesSection"
import type { PatchOutcome } from "@/hooks/useProjectSettings"

function renderSection(overrides: Partial<Parameters<typeof LanguagesSection>[0]> = {}) {
  const patch = vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))
  const props = {
    defaultTargetLanguage: "French",
    targetLanes: ["fr-CA"],
    canEdit: true,
    disabledTooltip: null as string | null,
    patch,
    ...overrides,
  }
  const utils = render(<LanguagesSection {...props} />)
  return { ...utils, patch }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("LanguagesSection", () => {
  it("renders the default target language read-only", () => {
    renderSection({ defaultTargetLanguage: "French" })
    expect(screen.getByText("French")).toBeTruthy()
  })

  it("renders the existing lanes list", () => {
    renderSection({ targetLanes: ["fr-CA", "fr-BE"] })
    const list = screen.getByTestId("target-lanes-list")
    expect(list.textContent).toContain("fr-CA")
    expect(list.textContent).toContain("fr-BE")
  })

  it("shows an empty state when there are no extra lanes", () => {
    renderSection({ targetLanes: [] })
    expect(screen.queryByTestId("target-lanes-list")).toBeNull()
    expect(screen.getByText(/no additional lanes yet/i)).toBeTruthy()
  })

  it("rejects an empty lane", async () => {
    const { patch } = renderSection({ targetLanes: [] })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/enter a language tag/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("rejects a duplicate lane (case-insensitive)", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "FR-ca" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("rejects a lane equal to the default target language (case-insensitive)", async () => {
    const { patch } = renderSection({ defaultTargetLanguage: "French", targetLanes: [] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "french" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/already the default/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("rejects a lane over 64 characters", async () => {
    const { patch } = renderSection({ targetLanes: [] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "a".repeat(65) } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/64 characters or fewer/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("trims whitespace before validating and saving", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "  fr-BE  " } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["fr-CA", "fr-BE"] }))
  })

  it("saves a valid new lane via patch with the appended array", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "fr-BE" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["fr-CA", "fr-BE"] }))
    // Input clears on success.
    await waitFor(() =>
      expect((screen.getByTestId("add-target-lang-input") as HTMLInputElement).value).toBe(""),
    )
  })

  it("surfaces a conflict outcome from patch without clearing the input", async () => {
    const patch = vi.fn(async (): Promise<PatchOutcome> => ({
      kind: "conflict",
      latest: { version: 2, updatedAt: "", updatedBy: null, settings: {} },
    }))
    render(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={["fr-CA"]}
        canEdit
        disabledTooltip={null}
        patch={patch}
      />,
    )
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "fr-BE" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/someone else updated/i)).toBeTruthy())
    expect((screen.getByTestId("add-target-lang-input") as HTMLInputElement).value).toBe("fr-BE")
  })

  it("archives a lane after confirmation, calling patch with the appended archivedLanes", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA", "fr-BE"], archivedLanes: [] })
    fireEvent.click(screen.getByTestId("archive-lane-fr-CA"))
    // Confirm button appears in place of the archive icon.
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    // Archiving keeps the lane in targetLanes; it only adds the tag to archivedLanes.
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ archivedLanes: ["fr-CA"] }))
  })

  it("does not call patch if archive is cancelled", () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA", "fr-BE"] })
    fireEvent.click(screen.getByTestId("archive-lane-fr-CA"))
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    expect(patch).not.toHaveBeenCalled()
    expect(screen.getByTestId("target-lanes-list").textContent).toContain("fr-CA")
  })

  it("lists archived lanes separately and restores one via patch", async () => {
    const { patch } = renderSection({
      targetLanes: ["fr-CA", "fr-BE"],
      archivedLanes: ["fr-BE"],
    })
    // fr-BE is archived → out of the active list, into the archived list.
    expect(screen.getByTestId("target-lanes-list").textContent).toContain("fr-CA")
    expect(screen.getByTestId("target-lanes-list").textContent).not.toContain("fr-BE")
    const archivedList = screen.getByTestId("archived-lanes-list")
    expect(archivedList.textContent).toContain("fr-BE")
    // Active lanes don't offer a restore control.
    expect(screen.queryByTestId("restore-lane-fr-CA")).toBeNull()

    fireEvent.click(screen.getByTestId("restore-lane-fr-BE"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ archivedLanes: [] }))
  })

  it("hides write controls (add, archive, restore) below the role floor", () => {
    renderSection({
      canEdit: false,
      targetLanes: ["fr-CA", "fr-BE"],
      archivedLanes: ["fr-BE"],
      disabledTooltip: "Maintainer or higher can edit shared settings.",
    })
    expect((screen.getByTestId("add-target-lang-btn") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("add-target-lang-input") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId("archive-lane-fr-CA") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("restore-lane-fr-BE") as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the disabled-reason note when write controls are gated", () => {
    renderSection({ canEdit: false, disabledTooltip: "Maintainer or higher can edit shared settings." })
    expect(screen.getByText(/maintainer or higher can edit shared settings/i)).toBeTruthy()
  })
})
