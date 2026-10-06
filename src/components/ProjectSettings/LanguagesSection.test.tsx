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

// AQU-1592 — lane identity on the languages screen: the LANGUAGE is required,
// the NAME is an optional override whose placeholder is the language, and the
// CODE override hides behind an "Advanced" disclosure showing the derived code.
//
// The product rule these guard is "store only what the user typed". A derived
// name or code written at create time keeps claiming the old language after the
// label is edited, which is the root cause of AQU-1585 — so the assertions below
// are about what the screen SUBMITS, not only about what it renders.
describe("LanguagesSection — lane identity fields (AQU-1592)", () => {
  const LANGUAGE_ONLY: ProjectLaneView = {
    id: "lane-yo",
    role: "target",
    // Stores no name and no code: it displays and resolves via its language.
    language: "Yoruba",
    name: null,
    langCode: null,
    legacyTag: "Yoruba",
    position: 1,
    archivedAt: null,
  }
  const DEFAULT_LANE: ProjectLaneView = {
    id: "lane-default",
    role: "target",
    language: "French",
    name: null,
    langCode: null,

    legacyTag: "",
    position: 0,
    archivedAt: null,
  }

  function renderIdentity(
    lanes: ProjectLaneView[] = [DEFAULT_LANE, LANGUAGE_ONLY],
    results: {
      create?: "ok" | "duplicate" | "invalid" | "malformed_code"
      edit?: "ok" | "duplicate" | "invalid" | "malformed_code"
    } = {},
  ) {
    const onCreateLane = vi.fn(async () => results.create ?? ("ok" as const))
    const onRenameLane = vi.fn(async () => results.edit ?? ("ok" as const))
    render(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={["Yoruba"]}
        canEdit
        disabledTooltip={null}
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
        laneRecords={lanes}
        onRenameLane={onRenameLane}
        onCreateLane={onCreateLane}
        onSetLaneArchived={vi.fn(async () => true)}
      />,
    )
    return { onCreateLane, onRenameLane }
  }

  it("shows a lane that carries only a language, with the language as the name placeholder", () => {
    renderIdentity()
    expect((screen.getByTestId("lane-language-lane-yo") as HTMLInputElement).value).toBe("Yoruba")
    const nameField = screen.getByTestId("lane-name-input-lane-yo") as HTMLInputElement
    // Empty value, language placeholder: the name is genuinely unset, and the
    // placeholder says what the lane shows instead.
    expect(nameField.value).toBe("")
    expect(nameField.placeholder).toBe("Yoruba")
  })

  it("renders the code derived from the language, which is not stored", () => {
    renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, language: "Spanish", legacyTag: "Spanish" },
    ])
    expect(screen.getByText("es")).toBeTruthy()
  })

  it("submits a language edit as a language, not a rename", async () => {
    const { onRenameLane } = renderIdentity()
    const field = screen.getByTestId("lane-language-lane-yo")
    fireEvent.change(field, { target: { value: "Yoruba (Oyo)" } })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { language: "Yoruba (Oyo)" }),
    )
  })

  it("refuses to blank a lane's language", async () => {
    const { onRenameLane } = renderIdentity()
    const field = screen.getByTestId("lane-language-lane-yo") as HTMLInputElement
    fireEvent.change(field, { target: { value: "  " } })
    fireEvent.blur(field)
    await waitFor(() => expect(screen.getByText(/needs a language/i)).toBeTruthy())
    expect(onRenameLane).not.toHaveBeenCalled()
    // The field snaps back, so the row keeps showing what is actually stored.
    expect(field.value).toBe("Yoruba")
  })

  it("clears the name override when the name field is emptied", async () => {
    const { onRenameLane } = renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, name: "Draft Yoruba" },
    ])
    const field = screen.getByTestId("lane-name-input-lane-yo")
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)
    // null CLEARS the override — it does not write the language back as a name.
    await waitFor(() => expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { name: null }))
  })

  it("hides the code override until Advanced is opened, then shows the derived code as its placeholder", () => {
    renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, language: "Spanish", legacyTag: "Spanish" },
    ])
    expect(screen.queryByTestId("lane-code-lane-yo")).toBeNull()
    fireEvent.click(screen.getByTestId("lane-advanced-toggle-lane-yo"))
    const code = screen.getByTestId("lane-code-lane-yo") as HTMLInputElement
    expect(code.value).toBe("")
    expect(code.placeholder).toBe("es")
  })

  it("opens Advanced already expanded for a lane that has an override", () => {
    renderIdentity([DEFAULT_LANE, { ...LANGUAGE_ONLY, langCode: "yo-NG" }])
    const code = screen.getByTestId("lane-code-lane-yo") as HTMLInputElement
    expect(code.value).toBe("yo-NG")
  })

  it("submits a code override and reports a malformed one", async () => {
    const { onRenameLane } = renderIdentity([DEFAULT_LANE, LANGUAGE_ONLY], {
      edit: "malformed_code",
    })
    fireEvent.click(screen.getByTestId("lane-advanced-toggle-lane-yo"))
    const code = screen.getByTestId("lane-code-lane-yo")
    fireEvent.change(code, { target: { value: "not a tag!" } })
    fireEvent.blur(code)
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { code: "not a tag!" }),
    )
    expect(screen.getByText(/not a valid language code/i)).toBeTruthy()
  })

  it("creates the first target from a source-only project without patching settings", async () => {
    const source: ProjectLaneView = {
      id: "lane-source",
      role: "source",
      language: "English",
      name: null,
      langCode: null,
      legacyTag: null,
      position: 0,
      archivedAt: null,
    }
    const patch = vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))
    const onCreateLane = vi.fn(async () => "ok" as const)
    render(
      <LanguagesSection
        defaultTargetLanguage="Spanish"
        targetLanes={[]}
        canEdit
        disabledTooltip={null}
        patch={patch}
        laneRecords={[source]}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={onCreateLane}
        onSetLaneArchived={vi.fn(async () => true)}
      />,
    )
    expect(screen.queryByText("Spanish")).toBeNull()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "French" },
    })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({ name: "", language: "French", code: null }),
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it("creates a lane from a language alone, submitting no name", async () => {
    const { onCreateLane } = renderIdentity()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Swahili" },
    })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    // name: "" — the server stores null, so the lane shows its language. A
    // derived "Swahili" name here is what AQU-1585 is about.
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({ name: "", language: "Swahili", code: null }),
    )
  })

  it("requires a language to create a lane", async () => {
    const { onCreateLane } = renderIdentity()
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/needs a language/i)).toBeTruthy())
    expect(onCreateLane).not.toHaveBeenCalled()
  })

  it("uses the typed language as the new lane's name placeholder", () => {
    renderIdentity()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Swahili" },
    })
    expect((screen.getByTestId("add-lane-name-input") as HTMLInputElement).placeholder).toBe(
      "Swahili",
    )
  })

  it("keeps the new lane's code override behind Advanced and submits it", async () => {
    const { onCreateLane } = renderIdentity()
    expect(screen.queryByTestId("add-lane-code-input")).toBeNull()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Spanish" },
    })
    fireEvent.click(screen.getByTestId("add-lane-advanced-toggle"))
    const code = screen.getByTestId("add-lane-code-input") as HTMLInputElement
    expect(code.placeholder).toBe("es")
    fireEvent.change(code, { target: { value: "es-MX" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Spanish",
        code: "es-MX",
      }),
    )
  })

  it("reports a malformed code from the create path", async () => {
    renderIdentity([DEFAULT_LANE, LANGUAGE_ONLY], { create: "malformed_code" })
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Spanish" },
    })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/not a valid language code/i)).toBeTruthy())
  })
})

// AQU-1600: the lane a project was created with (the "default lane", recorded
// with an empty legacy tag) used to be pulled out of the archivable list
// entirely — it had no archive control at all. It is now an ordinary lane. The
// one rule left is that a project keeps at least one ACTIVE target lane, so
// the last one's control is disabled instead of offering a click the server
// would refuse with `last_lane`.
describe("LanguagesSection — the former default lane archives like any other (AQU-1600)", () => {
  const DEFAULT_LANE: ProjectLaneView = {
    id: "lane-default",
    role: "target",
    language: "French",
    name: null,
    langCode: null,
    legacyTag: "",
    position: 0,
    archivedAt: null,
  }
  const SPANISH: ProjectLaneView = {
    id: "lane-es",
    role: "target",
    name: "Spanish",
    langCode: "es",
    legacyTag: "es",
    position: 1,
    archivedAt: null,
  }

  function renderLanes(lanes: ProjectLaneView[], canEdit = true) {
    const onSetLaneArchived = vi.fn(async () => true)
    const utils = renderWithTooltips(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={["fr", "es"]}
        canEdit={canEdit}
        disabledTooltip={canEdit ? null : "You need Project Lead to change languages."}
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
        laneRecords={lanes}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={vi.fn(async () => "ok" as const)}
        onSetLaneArchived={onSetLaneArchived}
      />,
    )
    return { ...utils, onSetLaneArchived }
  }

  it("offers an archive control on the former default lane and archives it by lane id", async () => {
    const { onSetLaneArchived } = renderLanes([DEFAULT_LANE, SPANISH])
    const button = screen.getByTestId("archive-lane-lane-default")
    expect(button.hasAttribute("disabled")).toBe(false)
    // The row stores no name — the confirmation names the language.
    expect(button.getAttribute("aria-label")).toMatch(/French/)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-default", true))
  })

  it("lists the archived former default lane with a restore control", () => {
    renderLanes([{ ...DEFAULT_LANE, archivedAt: "2026-10-03T00:00:00.000Z" }, SPANISH])
    // No second archive control for a lane that is already archived…
    expect(screen.queryByTestId("archive-lane-lane-default")).toBeNull()
    // …and it is restorable from the archived list.
    const archivedList = screen.getByTestId("archived-lanes-list")
    expect(archivedList.textContent).toContain("French")
  })

  it("refuses the project's only active lane, and says why", async () => {
    const { onSetLaneArchived } = renderLanes([DEFAULT_LANE])
    const button = screen.getByTestId("archive-lane-lane-default")
    expect(button.hasAttribute("disabled")).toBe(true)
    await expectTooltip(button, /only active lane/i)
    expect(onSetLaneArchived).not.toHaveBeenCalled()
  })

  it("refuses an extra lane too when it is the only active one left", () => {
    renderLanes([{ ...DEFAULT_LANE, archivedAt: "2026-10-03T00:00:00.000Z" }, SPANISH])
    expect(screen.getByTestId("archive-lane-lane-es").hasAttribute("disabled")).toBe(true)
  })

  it("still shows the permission reason, not the last-lane one, when the user cannot edit", async () => {
    renderLanes([DEFAULT_LANE, SPANISH], false)
    const button = screen.getByTestId("archive-lane-lane-default")
    expect(button.hasAttribute("disabled")).toBe(true)
    await expectTooltip(button, /project lead/i)

  })
})
