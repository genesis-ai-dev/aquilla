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
import type { LaneLastChangeResult, ProjectLaneView } from "@/lib/sync/project-settings"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

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

  it("allows adding the primary target language when it is not yet in targetLanes", async () => {
    const { patch } = renderSection({ defaultTargetLanguage: "French", targetLanes: [] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "french" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["french"] }))
    expect(screen.queryByText(/already the default/i)).toBeNull()
  })

  it("rejects re-adding the primary once it is already registered in targetLanes", async () => {
    const { patch } = renderSection({ defaultTargetLanguage: "French", targetLanes: ["French"] })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "french" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
    expect(screen.queryByText(/already the default/i)).toBeNull()
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

  it("shows the disabled-reason hint on a locked write control", async () => {
    renderWithTooltips(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={[]}
        canEdit={false}
        disabledTooltip="Maintainer or higher can edit shared settings."
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
      />,
    )
    await expectTooltip(
      screen.getByTestId("add-target-lang-btn"),
      /maintainer or higher can edit shared settings/i,
    )
  })
})

// AQU-1464 — the archive confirmation reports when the lane was last translated
// in, so a PM can tell a dormant lane from one someone is working in right now.
// Archiving is a hard write-lock (AQU-1462 / AQU-1463), so this is the last
// chance to notice. Exercised through the lane-ROW mode (`laneRecords`), which is
// what a cloud project renders; the legacy tag-string mode has no lane id to ask
// the server about and deliberately shows no activity line.
describe("LanguagesSection — lane last-change in the archive confirmation (AQU-1464)", () => {
  const SPANISH: ProjectLaneView = {
    id: "lane-es",
    role: "target",
    name: "Spanish",
    langCode: "es",
    legacyTag: "es",
    position: 1,
    archivedAt: null,
  }
  const DEFAULT_LANE: ProjectLaneView = {
    id: "lane-default",
    role: "target",
    name: "French",
    langCode: "fr",
    legacyTag: "",
    position: 0,
    archivedAt: null,
  }

  function renderRows(
    onLoadLaneLastChange?: (laneId: string) => Promise<LaneLastChangeResult>,
    lanes: ProjectLaneView[] = [DEFAULT_LANE, SPANISH],
  ) {
    const onSetLaneArchived = vi.fn(async () => true)
    render(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={["fr", "es"]}
        canEdit
        disabledTooltip={null}
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
        laneRecords={lanes}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={vi.fn(async () => "ok" as const)}
        onSetLaneArchived={onSetLaneArchived}
        onLoadLaneLastChange={onLoadLaneLastChange}
      />,
    )
    return { onSetLaneArchived }
  }

  it("names the date and the member who made the lane's newest edit", async () => {
    const at = Date.UTC(2026, 8, 28, 12, 0, 0)
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({
      kind: "ok",
      lastChange: { at, by: "carol" },
    }))
    renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/carol/))
    expect(note.textContent).toMatch(/2026/)
    // No raw i18n key leaks into the rendered string.
    expect(note.textContent).not.toMatch(/projectSettings\./)
    // It asked about THIS lane only — a project-wide lookup would be the bug.
    expect(load).toHaveBeenCalledWith("lane-es")
    // Date and name are bidi-isolated (lib/i18n/format.ts): both are Latin /
    // numeric tokens inside prose, so without the isolates Arabic reorders them
    // against the sentence. Silent to an English reader, which is why it needs a
    // test rather than review.
    expect(note.textContent).toContain("\u2068carol\u2069")
  })

  it("asks only about the lane being archived, so another lane's edits can't leak in", async () => {
    const load = vi.fn(async (laneId: string): Promise<LaneLastChangeResult> => ({
      kind: "ok",
      lastChange: laneId === "lane-es" ? null : { at: Date.now(), by: "carol" },
    }))
    renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    // The default lane has a fresh edit; Spanish does not. Spanish must say so.
    await waitFor(() => expect(note.textContent).toMatch(/no changes in this lane yet/i))
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith("lane-es")
  })

  it("says a never-edited lane has no changes rather than rendering a 1970 date", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({ kind: "ok", lastChange: null }))
    renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/no changes in this lane yet/i))
    expect(note.textContent).not.toMatch(/1970|Invalid Date/i)
  })

  it("reports a failed lookup as unavailable — never as 'no changes yet' — and still archives", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({
      kind: "error",
      message: "last-change failed (500)",
    }))
    const { onSetLaneArchived } = renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/last change unavailable/i))
    // "No changes yet" would read as "dormant, safe to archive" — a conclusion
    // the server never gave us.
    expect(note.textContent).not.toMatch(/no changes in this lane yet/i)
    // The confirmation is not blocked by the failed read.
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-es", true))
  })

  it("treats a thrown lookup the same as a failed one", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => {
      throw new Error("offline")
    })
    const { onSetLaneArchived } = renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/last change unavailable/i))
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-es", true))
  })

  it("drops the 'by <name>' clause when the newest edit records no editor", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({
      kind: "ok",
      lastChange: { at: Date.UTC(2026, 8, 28, 12, 0, 0), by: null },
    }))
    renderRows(load)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/2026/))
    expect(note.textContent).not.toMatch(/\bby\b/i)
    expect(note.textContent).not.toMatch(/null|undefined/i)
  })

  it("only looks the date up when the confirmation is open, not on every render", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({ kind: "ok", lastChange: null }))
    renderRows(load)
    expect(load).not.toHaveBeenCalled()
    expect(screen.queryByTestId("lane-last-change-lane-es")).toBeNull()
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    await screen.findByTestId("lane-last-change-lane-es")
    expect(load).toHaveBeenCalledTimes(1)
    // Cancelling takes the line away and leaves the lane active.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByTestId("lane-last-change-lane-es")).toBeNull())
    // Spanish is still an ACTIVE lane — cancelling archived nothing. In row mode
    // the lane's name lives in its rename input, not in the row's text.
    expect(
      screen
        .getAllByLabelText(/lane name/i)
        .map((el) => (el as HTMLInputElement).value),
    ).toContain("Spanish")
    expect(screen.queryByTestId("archived-lanes-list")).toBeNull()
  })

  it("omits the activity line entirely when no lookup is wired (local project)", async () => {
    renderRows(undefined)
    fireEvent.click(screen.getByTestId("archive-lane-lane-es"))
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm archive/i })).toBeTruthy())
    expect(screen.queryByTestId("lane-last-change-lane-es")).toBeNull()
  })
})
