// AQU-538 slice 2 — LanguagesSection component tests.
//
// `patch` is injected as a prop (it's ProjectSettings.tsx's `patchShared`,
// itself `useProjectSettings(...).patch`), so these tests exercise the
// component in isolation with a stubbed patch function rather than standing
// up the whole ProjectSettings tree or a network layer.
//
// Media redesign (Sam, Oct 25, design B): the card is a compact table. A row's
// ⋯ menu holds Rename, Language and code…, and Archive; "Add language lane" opens a
// small form; archived languages sit in a collapsed "Archived (n)" group; and
// explanations live behind (i) icons, which is why several tests hover one.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LanguagesSection, type LaneDeliversOutcome } from "./LanguagesSection"
import type { LaneDelivers } from "@/lib/lanes/lane-delivers"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { LaneLastChangeResult, ProjectLaneView } from "@/lib/sync/project-settings"
import { renderWithTooltips } from "@/test-utils/tooltip"

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

/** "Add language lane" opens the add form. */
function openAddForm() {
  fireEvent.click(screen.getByTestId("add-lane-open"))
}

/** The row's ⋯ menu. */
function openRowMenu(key: string) {
  fireEvent.click(screen.getByTestId(`lane-menu-${key}`))
}

/** ⋯ → Archive: opens the confirmation under the row. */
function askToArchive(key: string) {
  openRowMenu(key)
  fireEvent.click(screen.getByTestId(`archive-lane-${key}`))
}

function openArchived() {
  fireEvent.click(screen.getByTestId("archived-lanes-toggle"))
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** AQU-2260 (Sam, Oct 29): an (i) opens its text in place on CLICK and shuts it
 *  on a second click. Hovering it shows nothing. */
async function expectInPlaceInfo(button: HTMLElement, text: RegExp | string) {
  await userEvent.setup().hover(button)
  expect(screen.queryByRole("tooltip")).toBeNull()
  const reveal = document.getElementById(button.getAttribute("aria-controls") ?? "")
  expect(reveal).not.toBeNull()
  expect(reveal).toHaveAttribute("data-open", "false")
  fireEvent.click(button)
  expect(button).toHaveAttribute("aria-expanded", "true")
  expect(reveal).toHaveAttribute("data-open", "true")
  expect(reveal).toHaveTextContent(text)
  fireEvent.click(button)
  expect(reveal).toHaveAttribute("data-open", "false")
}

describe("LanguagesSection", () => {
  it("lists the project's target language with the other target lanes", () => {
    renderSection({ defaultTargetLanguage: "French" })
    expect(screen.getByTestId("target-lanes-list").textContent).toContain("French")
    expect(screen.queryByText("Default target language")).toBeNull()
  })

  it("renders the existing lanes list as a table with Language, Name and Code columns", () => {
    renderSection({ targetLanes: ["fr-CA", "fr-BE"] })
    const list = screen.getByTestId("target-lanes-list")
    expect(list).toHaveAttribute("role", "table")
    expect(list.textContent).toContain("fr-CA")
    expect(list.textContent).toContain("fr-BE")
    // AQU-2174: the language leads.
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Language",
      "Name",
      "Code",
      "Actions",
    ])
  })

  it("shows an empty state when there are no target lanes", () => {
    renderSection({ defaultTargetLanguage: "", targetLanes: [] })
    expect(screen.queryByTestId("target-lanes-list")).toBeNull()
    expect(screen.getByText(/no language lanes yet/i)).toBeTruthy()
  })

  it("keeps the add form closed behind one Add language button", () => {
    renderSection()
    expect(screen.queryByTestId("add-lane-form")).toBeNull()
    openAddForm()
    expect(screen.getByTestId("add-lane-form")).toBeTruthy()
    expect(screen.getByText("Add a language lane")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    expect(screen.queryByTestId("add-lane-form")).toBeNull()
  })

  it("opens the add form straight away for the editor's Add lane… deep link", () => {
    renderSection({ startAdding: true })
    expect(screen.getByTestId("add-lane-form")).toBeTruthy()
    expect(document.getElementById("add-lane-field")?.contains(screen.getByTestId("add-lane-form"))).toBe(true)
  })

  it("rejects an empty lane", async () => {
    const { patch } = renderSection({ targetLanes: [] })
    openAddForm()
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/enter a language name/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("rejects a duplicate lane (case-insensitive)", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "FR-ca" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("allows adding the primary target language when it is not yet in targetLanes", async () => {
    const { patch } = renderSection({ defaultTargetLanguage: "French", targetLanes: [] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "french" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["french"] }))
    expect(screen.queryByText(/already the default/i)).toBeNull()
  })

  it("rejects re-adding the primary once it is already registered in targetLanes", async () => {
    const { patch } = renderSection({ defaultTargetLanguage: "French", targetLanes: ["French"] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "french" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
    expect(screen.queryByText(/already the default/i)).toBeNull()
  })

  it("rejects a lane over 64 characters", async () => {
    const { patch } = renderSection({ targetLanes: [] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "a".repeat(65) } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/64 characters or fewer/i)).toBeTruthy())
    expect(patch).not.toHaveBeenCalled()
  })

  it("trims whitespace before validating and saving", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "  fr-BE  " } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["fr-CA", "fr-BE"] }))
  })

  it("creates a lane row for a cloud project that has none yet", async () => {
    const onCreateLane = vi.fn(async () => "ok" as const)
    const { patch } = renderSection({ targetLanes: [], laneRecords: [], onCreateLane })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "es" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    // AQU-1592: the name is sent only when the user typed one.
    await waitFor(() => expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "es",
        code: null,
        allowDuplicateName: false,
      }))
    expect(patch).not.toHaveBeenCalled()
  })

  it("saves a valid new lane via patch with the appended array, then closes the form", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA"] })
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "fr-BE" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ targetLanes: ["fr-CA", "fr-BE"] }))
    await waitFor(() => expect(screen.queryByTestId("add-lane-form")).toBeNull())
    // Opened again, it starts empty.
    openAddForm()
    expect((screen.getByTestId("add-target-lang-input") as HTMLInputElement).value).toBe("")
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
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "fr-BE" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/someone else updated/i)).toBeTruthy())
    expect((screen.getByTestId("add-target-lang-input") as HTMLInputElement).value).toBe("fr-BE")
  })

  it("archives a lane after confirmation, calling patch with the appended archivedLanes", async () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA", "fr-BE"], archivedLanes: [] })
    askToArchive("fr-CA")
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    // Archiving keeps the lane in targetLanes; it only adds the tag to archivedLanes.
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ archivedLanes: ["fr-CA"] }))
  })

  it("does not call patch if archive is cancelled", () => {
    const { patch } = renderSection({ targetLanes: ["fr-CA", "fr-BE"] })
    askToArchive("fr-CA")
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    expect(patch).not.toHaveBeenCalled()
    expect(screen.queryByTestId("archive-confirm-fr-CA")).toBeNull()
    expect(screen.getByTestId("target-lanes-list").textContent).toContain("fr-CA")
  })

  it("keeps archived lanes in a collapsed Archived (n) group and restores one via patch", async () => {
    const { patch } = renderSection({
      targetLanes: ["fr-CA", "fr-BE"],
      archivedLanes: ["fr-BE"],
    })
    // fr-BE is archived → out of the active list, into the archived group.
    expect(screen.getByTestId("target-lanes-list").textContent).toContain("fr-CA")
    expect(screen.getByTestId("target-lanes-list").textContent).not.toContain("fr-BE")
    expect(screen.getByTestId("archived-lanes-toggle").textContent).toBe("Archived (1)")
    // Collapsed until asked for.
    expect(screen.queryByTestId("archived-lanes-list")).toBeNull()
    openArchived()
    expect(screen.getByTestId("archived-lanes-list").textContent).toContain("fr-BE")
    // Active lanes don't offer a restore control.
    expect(screen.queryByTestId("restore-lane-fr-CA")).toBeNull()

    fireEvent.click(screen.getByTestId("restore-lane-fr-BE"))
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ archivedLanes: [] }))
  })

  it("draws no Archived group when nothing is archived", () => {
    renderSection({ targetLanes: ["fr-CA", "fr-BE"] })
    expect(screen.queryByTestId("archived-lanes-toggle")).toBeNull()
  })

  it("disables write controls (add, the row menu, restore) below the role floor, and says why once at the top", () => {
    renderSection({
      canEdit: false,
      targetLanes: ["fr-CA", "fr-BE"],
      archivedLanes: ["fr-BE"],
      disabledTooltip: "Maintainer or higher can edit shared settings.",
    })
    // AQU-2260: one line under the card's title, not a View only (i).
    expect(screen.getByTestId("languages-view-only").textContent).toContain("Maintainer or higher can edit shared settings.")
    expect(screen.getAllByText("Maintainer or higher can edit shared settings.")).toHaveLength(1)
    expect((screen.getByTestId("add-lane-open") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("lane-menu-fr-CA") as HTMLButtonElement).disabled).toBe(true)
    // Looking is not a write: the archived group still opens.
    openArchived()
    expect((screen.getByTestId("restore-lane-fr-BE") as HTMLButtonElement).disabled).toBe(true)
  })

  it("every other (i) in the card opens its text in place, on click (AQU-2260)", async () => {
    renderSection({ targetLanes: ["fr-CA", "fr-BE"], archivedLanes: ["fr-BE"] })
    await expectInPlaceInfo(screen.getByRole("button", { name: "About language lanes" }), /./)
    await expectInPlaceInfo(screen.getByRole("button", { name: "About archived language lanes" }), /./)
  })

  it("says nothing about a lock to someone who can edit", () => {
    renderSection()
    expect(screen.queryByTestId("languages-view-only")).toBeNull()
  })

  // AQU-2260 (Sam, Oct 29): the reason is on the page, never a hover, and
  // there is no (i) to find it behind.
  it("says why the card is locked on the page, with no hover and no (i)", async () => {
    renderWithTooltips(
      <LanguagesSection
        defaultTargetLanguage="French"
        targetLanes={[]}
        canEdit={false}
        disabledTooltip="You need Project lead to change languages."
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
      />,
    )
    expect(screen.getByTestId("languages-view-only")).toHaveTextContent("You need Project lead to change languages.")
    expect(screen.queryByRole("button", { name: "Why you can't change languages" })).toBeNull()
    await userEvent.setup().hover(screen.getByTestId("add-lane-open"))
    expect(screen.queryByRole("tooltip")).toBeNull()
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
    renderWithTooltips(
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
    askToArchive("lane-es")
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
    expect(note.textContent).toContain("⁨carol⁩")
  })

  it("asks a short question, with the explanation behind its (i)", async () => {
    renderRows(vi.fn(async (): Promise<LaneLastChangeResult> => ({ kind: "ok", lastChange: null })))
    askToArchive("lane-es")
    const confirm = await screen.findByTestId("archive-confirm-lane-es")
    expect(confirm.textContent).toContain('Archive "Spanish"?')
    // AQU-2260: shut until its (i) is clicked, then open in place.
    await expectInPlaceInfo(screen.getByRole("button", { name: "About archiving" }), /restore it at any time/)
  })

  it("puts the archive confirmation on its own line, under the lane's row", async () => {
    // The confirmation used to share the identity flex row, so it squeezed the
    // language and name boxes. It is the next row of the table, full width.
    renderRows(vi.fn(async (): Promise<LaneLastChangeResult> => ({ kind: "ok", lastChange: null })))
    askToArchive("lane-es")
    const confirm = await screen.findByTestId("archive-confirm-lane-es")
    const row = screen.getByTestId("lane-identity-row-lane-es")
    expect(row.contains(confirm)).toBe(false)
    expect(confirm.parentElement?.parentElement).toBe(row.parentElement)
    expect(confirm.className).toContain("w-full")
    expect(row.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps a derived lane code in the row, out of the archive confirmation", async () => {
    // AQU-2046: archiving Samoan put the derived code "sm" on the last-change
    // line. It stays in the row's Code column.
    const samoan: ProjectLaneView = {
      id: "lane-sm",
      role: "target",
      language: "Samoan",
      name: null,
      langCode: null,
      legacyTag: null,
      position: 1,
      archivedAt: null,
    }
    const { onSetLaneArchived } = renderRows(
      vi.fn(async (): Promise<LaneLastChangeResult> => ({
        kind: "ok",
        lastChange: { at: Date.UTC(2026, 9, 13), by: "matthew_test" },
      })),
      [DEFAULT_LANE, samoan],
    )
    askToArchive("lane-sm")
    const confirm = await screen.findByTestId("archive-confirm-lane-sm")
    const code = screen.getByTestId("lane-language-code-lane-sm")
    const row = screen.getByTestId("lane-identity-row-lane-sm")
    expect(code.textContent).toBe("sm")
    expect(confirm.contains(code)).toBe(false)
    expect(row.contains(code)).toBe(true)
    expect(confirm.textContent).toMatch(/samoan/i)
    expect(confirm.contains(screen.getByRole("button", { name: /confirm archive/i }))).toBe(true)
    expect(confirm.contains(screen.getByRole("button", { name: /^cancel$/i }))).toBe(true)
    const note = await screen.findByTestId("lane-last-change-lane-sm")
    expect(confirm.contains(note)).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByTestId("archive-confirm-lane-sm")).toBeNull())
    expect(onSetLaneArchived).not.toHaveBeenCalled()
    expect(screen.getByTestId("lane-language-code-lane-sm").textContent).toBe("sm")

    askToArchive("lane-sm")
    fireEvent.click(await screen.findByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-sm", true))
  })

  it("asks only about the lane being archived, so another lane's edits can't leak in", async () => {
    const load = vi.fn(async (laneId: string): Promise<LaneLastChangeResult> => ({
      kind: "ok",
      lastChange: laneId === "lane-es" ? null : { at: Date.now(), by: "carol" },
    }))
    renderRows(load)
    askToArchive("lane-es")
    const note = await screen.findByTestId("lane-last-change-lane-es")
    // The default lane has a fresh edit; Spanish does not. Spanish must say so.
    await waitFor(() => expect(note.textContent).toMatch(/no changes in this language lane yet/i))
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith("lane-es")
  })

  it("says a never-edited lane has no changes rather than rendering a 1970 date", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({ kind: "ok", lastChange: null }))
    renderRows(load)
    askToArchive("lane-es")
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/no changes in this language lane yet/i))
    expect(note.textContent).not.toMatch(/1970|Invalid Date/i)
  })

  it("reports a failed lookup as unavailable — never as 'no changes yet' — and still archives", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => ({
      kind: "error",
      message: "last-change failed (500)",
    }))
    const { onSetLaneArchived } = renderRows(load)
    askToArchive("lane-es")
    const note = await screen.findByTestId("lane-last-change-lane-es")
    await waitFor(() => expect(note.textContent).toMatch(/last change unavailable/i))
    // "No changes yet" would read as "dormant, safe to archive" — a conclusion
    // the server never gave us.
    expect(note.textContent).not.toMatch(/no changes in this language lane yet/i)
    // The confirmation is not blocked by the failed read.
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-es", true))
  })

  it("treats a thrown lookup the same as a failed one", async () => {
    const load = vi.fn(async (): Promise<LaneLastChangeResult> => {
      throw new Error("offline")
    })
    const { onSetLaneArchived } = renderRows(load)
    askToArchive("lane-es")
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
    askToArchive("lane-es")
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
    askToArchive("lane-es")
    await screen.findByTestId("lane-last-change-lane-es")
    expect(load).toHaveBeenCalledTimes(1)
    // Cancelling takes the line away and leaves the lane active.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByTestId("lane-last-change-lane-es")).toBeNull())
    // Spanish is still an ACTIVE lane — cancelling archived nothing.
    expect(screen.getByTestId("lane-name-lane-es").textContent).toBe("Spanish")
    expect(screen.queryByTestId("archived-lanes-toggle")).toBeNull()
  })

  it("omits the activity line entirely when no lookup is wired (local project)", async () => {
    renderRows(undefined)
    askToArchive("lane-es")
    await waitFor(() => expect(screen.getByRole("button", { name: /confirm archive/i })).toBeTruthy())
    expect(screen.queryByTestId("lane-last-change-lane-es")).toBeNull()
  })
})

// AQU-1592 — lane identity on the languages screen: the LANGUAGE is required,
// the NAME is an optional override whose placeholder is the language, and the
// CODE is an optional override whose placeholder is the derived code.
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
  const SOURCE: ProjectLaneView = {
    id: "lane-source",
    role: "source",
    language: "English",
    name: null,
    langCode: null,
    legacyTag: null,
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
    renderWithTooltips(
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

  /** Clicking a name opens that row's fields. */
  function openEdit(laneId: string) {
    fireEvent.click(screen.getByTestId(`lane-name-${laneId}`))
    return screen.getByTestId(`lane-edit-${laneId}`)
  }

  // AQU-2174: the row's first cell is the language, at every width — the Name
  // and Code columns are what fold away on a phone.
  it("leads each row with the language, the name after it", () => {
    renderIdentity([DEFAULT_LANE, { ...LANGUAGE_ONLY, name: "Yoruba team B", langCode: "yo-NG" }])
    const row = screen.getByTestId("lane-identity-row-lane-yo")
    const cells = [...row.querySelectorAll("[role=cell]")]
    expect(cells[0].textContent).toContain("Yoruba")
    expect(cells[0]).toContainElement(screen.getByTestId("lane-language-cell-lane-yo"))
    expect(cells[1]).toContainElement(screen.getByTestId("lane-name-lane-yo"))
    expect(screen.getByTestId("lane-name-lane-yo").textContent).toBe("Yoruba team B")
    // The phone-width line under the language carries the name and the code.
    expect(cells[0].textContent).toContain("Yoruba team B · yo-NG")
  })

  it("shows a lane that carries only a language under its language, in every column", () => {
    renderIdentity()
    expect(screen.getByTestId("lane-name-lane-yo").textContent).toBe("Yoruba")
    expect(screen.getByTestId("lane-language-cell-lane-yo").textContent).toBe("Yoruba")
    // Nothing to fold: the name IS the language, so it is not repeated.
    expect(screen.getByTestId("lane-identity-row-lane-yo").textContent).not.toContain("Yoruba · Yoruba")
    // No pills: the name, language and code are plain text.
    expect(screen.getByTestId("target-lanes-list").querySelector("[data-slot=badge]")).toBeNull()
  })

  it("opens the fields with the language as the name placeholder, not as a stored name", () => {
    renderIdentity()
    const edit = openEdit("lane-yo")
    expect((screen.getByTestId("lane-language-lane-yo") as HTMLInputElement).value).toBe("Yoruba")
    const nameField = screen.getByTestId("lane-name-input-lane-yo") as HTMLInputElement
    // Empty value, language placeholder: the name is genuinely unset, and the
    // placeholder says what the lane shows instead.
    expect(nameField.value).toBe("")
    expect(nameField.placeholder).toBe("Yoruba")
    expect(nameField).toHaveFocus()
    // Labelled fields, not bare boxes.
    expect(within(edit).getByLabelText("Name")).toBe(nameField)
    expect(within(edit).getByLabelText("Language")).toBe(screen.getByTestId("lane-language-lane-yo"))
    expect(within(edit).getByLabelText("Code")).toBe(screen.getByTestId("lane-code-lane-yo"))
  })

  // AQU-2174: the form reads the same way the table and the add form do.
  it("orders the form's fields Language, Name, Code", () => {
    renderIdentity()
    const edit = openEdit("lane-yo")
    expect(within(edit).getAllByRole("textbox").concat(within(edit).getAllByRole("combobox"))).toHaveLength(3)
    expect([...edit.querySelectorAll("label")].map((l) => l.textContent)).toEqual([
      "Language",
      "Name",
      "Code",
    ])
  })

  it("orders the source language's form the same way, opened from Change", () => {
    renderIdentity([SOURCE, DEFAULT_LANE, LANGUAGE_ONLY])
    fireEvent.click(screen.getByTestId("source-language-change"))
    const edit = screen.getByTestId("lane-edit-lane-source")
    expect([...edit.querySelectorAll("label")].map((l) => l.textContent)).toEqual([
      "Language",
      "Name",
      "Code",
    ])
  })

  it("renders the code derived from the language, which is not stored", () => {
    renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, language: "Spanish", legacyTag: "Spanish" },
    ])
    expect(screen.getByTestId("lane-language-code-lane-yo").textContent).toBe("es")
  })

  it("suggests language names when changing a lane's language", () => {
    renderIdentity()
    openEdit("lane-yo")
    const field = screen.getByTestId("lane-language-lane-yo")
    expect(field.getAttribute("role")).toBe("combobox")
  })

  // AQU-2174: "Rename" and "Language and code…" opened the same form and
  // differed only in the focused field, so the menu offers one Edit item.
  it("offers exactly Edit and Archive in the row menu", () => {
    renderIdentity()
    openRowMenu("lane-yo")
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit", "Archive"])
    expect(screen.queryByTestId("lane-rename-lane-yo")).toBeNull()
    expect(screen.queryByTestId("lane-edit-language-lane-yo")).toBeNull()
  })

  it("opens the whole form on the Language field from the row menu's Edit", () => {
    renderIdentity()
    openRowMenu("lane-yo")
    fireEvent.click(screen.getByTestId("lane-edit-action-lane-yo"))
    const edit = screen.getByTestId("lane-edit-lane-yo")
    expect(screen.getByTestId("lane-language-lane-yo")).toHaveFocus()
    // One form, all three fields: nothing the two items did is lost.
    expect(within(edit).getByLabelText("Language")).toBeTruthy()
    expect(within(edit).getByLabelText("Name")).toBeTruthy()
    expect(within(edit).getByLabelText("Code")).toBeTruthy()
  })

  it("saves a name and a code together from the one Edit form", async () => {
    const { onRenameLane } = renderIdentity()
    openRowMenu("lane-yo")
    fireEvent.click(screen.getByTestId("lane-edit-action-lane-yo"))
    fireEvent.change(screen.getByTestId("lane-name-input-lane-yo"), { target: { value: "Yoruba (Oyo)" } })
    fireEvent.change(screen.getByTestId("lane-code-lane-yo"), { target: { value: "yo-NG" } })
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { name: "Yoruba (Oyo)", code: "yo-NG" }),
    )
  })

  it("still opens on the Name field when the name itself is clicked", () => {
    renderIdentity()
    fireEvent.click(screen.getByTestId("lane-name-lane-yo"))
    expect(screen.getByTestId("lane-name-input-lane-yo")).toHaveFocus()
  })

  it("submits a language edit as a language, not a rename, on Save", async () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-language-lane-yo"), { target: { value: "Yoruba (Oyo)" } })
    // Nothing is saved until Save.
    expect(onRenameLane).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { language: "Yoruba (Oyo)" }),
    )
    await waitFor(() => expect(screen.queryByTestId("lane-edit-lane-yo")).toBeNull())
  })

  it("saves the name, language and code together, sending only what changed", async () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-name-input-lane-yo"), { target: { value: "Yoruba team B" } })
    fireEvent.change(screen.getByTestId("lane-code-lane-yo"), { target: { value: "yo-NG" } })
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { name: "Yoruba team B", code: "yo-NG" }),
    )
    expect(onRenameLane).toHaveBeenCalledTimes(1)
  })

  it("Cancel closes the fields and saves nothing", () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-name-input-lane-yo"), { target: { value: "Changed" } })
    fireEvent.click(screen.getByTestId("lane-cancel-lane-yo"))
    expect(screen.queryByTestId("lane-edit-lane-yo")).toBeNull()
    expect(onRenameLane).not.toHaveBeenCalled()
    expect(screen.getByTestId("lane-name-lane-yo").textContent).toBe("Yoruba")
  })

  it("Enter saves and Escape cancels", async () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.keyDown(screen.getByTestId("lane-name-input-lane-yo"), { key: "Escape" })
    expect(screen.queryByTestId("lane-edit-lane-yo")).toBeNull()
    openEdit("lane-yo")
    const name = screen.getByTestId("lane-name-input-lane-yo")
    fireEvent.change(name, { target: { value: "Oyo" } })
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { name: "Oyo" }))
  })

  it("saving with nothing changed just closes the fields", () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    expect(screen.queryByTestId("lane-edit-lane-yo")).toBeNull()
    expect(onRenameLane).not.toHaveBeenCalled()
  })

  it("refuses to blank a lane's language", async () => {
    const { onRenameLane } = renderIdentity()
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-language-lane-yo"), { target: { value: "  " } })
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    await waitFor(() => expect(screen.getByText(/needs a language/i)).toBeTruthy())
    expect(onRenameLane).not.toHaveBeenCalled()
    // The fields stay open so the language can be typed.
    expect(screen.getByTestId("lane-edit-lane-yo")).toBeTruthy()
  })

  it("clears the name override when the name field is emptied", async () => {
    const { onRenameLane } = renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, name: "Draft Yoruba" },
    ])
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-name-input-lane-yo"), { target: { value: "" } })
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    // null CLEARS the override — it does not write the language back as a name.
    await waitFor(() => expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { name: null }))
  })

  it("shows the derived code as the code field's placeholder, with its note behind (i)", async () => {
    renderIdentity([
      DEFAULT_LANE,
      { ...LANGUAGE_ONLY, language: "Spanish", legacyTag: "Spanish" },
    ])
    openEdit("lane-yo")
    const code = screen.getByTestId("lane-code-lane-yo") as HTMLInputElement
    expect(code.value).toBe("")
    expect(code.placeholder).toBe("es")
    await expectInPlaceInfo(screen.getByRole("button", { name: "About the code" }), /derive the code from the language/)
  })

  it("shows a code override in the code field", () => {
    renderIdentity([DEFAULT_LANE, { ...LANGUAGE_ONLY, langCode: "yo-NG" }])
    openEdit("lane-yo")
    expect((screen.getByTestId("lane-code-lane-yo") as HTMLInputElement).value).toBe("yo-NG")
  })

  it("submits a code override and reports a malformed one, keeping the fields open", async () => {
    const { onRenameLane } = renderIdentity([DEFAULT_LANE, LANGUAGE_ONLY], {
      edit: "malformed_code",
    })
    openEdit("lane-yo")
    fireEvent.change(screen.getByTestId("lane-code-lane-yo"), { target: { value: "not a tag!" } })
    fireEvent.click(screen.getByTestId("lane-save-lane-yo"))
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-yo", { code: "not a tag!" }),
    )
    expect(await screen.findByText(/not a valid language code/i)).toBeTruthy()
    expect(screen.getByTestId("lane-edit-lane-yo")).toBeTruthy()
  })

  // AQU-2174: language · name · code, the name only when it adds something.
  it("reads the source line language first, naming the override after it", () => {
    renderIdentity([{ ...SOURCE, name: "Greek NT", language: "Greek", langCode: "grc" }])
    expect(screen.getByTestId("source-language-line").textContent).toContain("Greek · Greek NT · grc")
  })

  it("shows a source whose name is just its language once", () => {
    renderIdentity([{ ...SOURCE, name: null, language: "Samoan", langCode: "sm" }])
    expect(screen.getByTestId("source-language-line").textContent).toContain("Samoan · sm")
  })

  it("shows the source as one line and changes it with Change", async () => {
    const { onRenameLane } = renderIdentity([SOURCE, DEFAULT_LANE, LANGUAGE_ONLY])
    const line = screen.getByTestId("source-language-line")
    expect(line.textContent).toContain("English")
    expect(line.textContent).toContain("en")
    fireEvent.click(screen.getByTestId("source-language-change"))
    expect(screen.getByTestId("lane-language-lane-source")).toHaveFocus()
    fireEvent.change(screen.getByTestId("lane-language-lane-source"), { target: { value: "Chinese" } })
    fireEvent.click(screen.getByTestId("lane-save-lane-source"))
    await waitFor(() =>
      expect(onRenameLane).toHaveBeenCalledWith("lane-source", { language: "Chinese" }),
    )
  })

  it("creates the first target from a source-only project without patching settings", async () => {
    const patch = vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))
    const onCreateLane = vi.fn(async () => "ok" as const)
    render(
      <LanguagesSection
        defaultTargetLanguage="Spanish"
        targetLanes={[]}
        canEdit
        disabledTooltip={null}
        patch={patch}
        laneRecords={[SOURCE]}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={onCreateLane}
        onSetLaneArchived={vi.fn(async () => true)}
      />,
    )
    expect(screen.queryByText("Spanish")).toBeNull()
    expect(screen.getByText(/no language lanes yet/i)).toBeTruthy()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "French" },
    })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "French",
        code: null,
        allowDuplicateName: false,
      }),
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it("creates a lane from a language alone, submitting no name", async () => {
    const { onCreateLane } = renderIdentity()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Swahili" },
    })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    // name: "" — the server stores null, so the lane shows its language. A
    // derived "Swahili" name here is what AQU-1585 is about.
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Swahili",
        code: null,
        allowDuplicateName: false,
      }),
    )
  })

  it("requires a language to create a lane", async () => {
    const { onCreateLane } = renderIdentity()
    openAddForm()
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() => expect(screen.getByText(/needs a language/i)).toBeTruthy())
    expect(onCreateLane).not.toHaveBeenCalled()
  })

  it("uses the typed language as the new lane's name placeholder, with the name note behind (i)", async () => {
    renderIdentity()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Swahili" },
    })
    expect((screen.getByTestId("add-lane-name-input") as HTMLInputElement).placeholder).toBe(
      "Swahili",
    )
    await expectInPlaceInfo(screen.getByRole("button", { name: "About the name" }), /starts as the language's name/i)
  })

  it("offers the new lane's optional code in the form and submits it", async () => {
    const { onCreateLane } = renderIdentity()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Spanish" },
    })
    expect(screen.getByText("Code (optional)")).toBeTruthy()
    const code = screen.getByTestId("add-lane-code-input") as HTMLInputElement
    expect(code.placeholder).toBe("es")
    fireEvent.change(code, { target: { value: "es-MX" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Spanish",
        code: "es-MX",
        allowDuplicateName: false,
      }),
    )
  })

  it("fills the empty code box with the code derived from the language name (AQU-1792)", async () => {
    renderIdentity()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), {
      target: { value: "Turkana" },
    })
    const code = screen.getByTestId("add-lane-code-input") as HTMLInputElement
    expect(code.value).toBe("")
    await waitFor(() => expect(code.placeholder).toBe("tuv"))
  })

  it("reports a malformed code from the create path", async () => {
    renderIdentity([DEFAULT_LANE, LANGUAGE_ONLY], { create: "malformed_code" })
    openAddForm()
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
    openRowMenu("lane-default")
    const item = screen.getByTestId("archive-lane-lane-default")
    expect(item).not.toHaveAttribute("aria-disabled", "true")
    // The row stores no name — the control names the language.
    expect(item.getAttribute("aria-label")).toMatch(/French/)
    fireEvent.click(item)
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-default", true))
  })

  // AQU-2174: the archived entries read language first too.
  it("reads an archived lane's entry language first, then its name and code", () => {
    renderLanes([
      { ...DEFAULT_LANE, name: "French (Africa)", langCode: "fr-AF", archivedAt: "2026-10-03T00:00:00.000Z" },
      SPANISH,
    ])
    openArchived()
    expect(screen.getByTestId("archived-lanes-list").textContent).toContain(
      "French · French (Africa) · fr-AF",
    )
  })

  it("names an archived lane whose name is just its language once", () => {
    renderLanes([
      { ...DEFAULT_LANE, language: "Samoan", name: null, langCode: "sm", archivedAt: "2026-10-03T00:00:00.000Z" },
      SPANISH,
    ])
    openArchived()
    expect(screen.getByTestId("archived-lanes-list").textContent).toContain("Samoan · sm")
    expect(screen.getByTestId("archived-lanes-list").textContent).not.toContain("Samoan · Samoan")
  })

  it("lists the archived former default lane with a restore control", () => {
    renderLanes([{ ...DEFAULT_LANE, archivedAt: "2026-10-03T00:00:00.000Z" }, SPANISH])
    // No row (and so no second archive control) for a lane that is already archived…
    expect(screen.queryByTestId("lane-menu-lane-default")).toBeNull()
    // …and it is restorable from the archived group.
    openArchived()
    expect(screen.getByTestId("archived-lanes-list").textContent).toContain("French")
    expect(screen.getByTestId("restore-lane-lane-default")).toBeTruthy()
  })

  it("refuses the project's only active lane, and says why", async () => {
    const { onSetLaneArchived } = renderLanes([DEFAULT_LANE])
    openRowMenu("lane-default")
    const item = screen.getByTestId("archive-lane-lane-default")
    expect(item).toHaveAttribute("aria-disabled", "true")
    // AQU-2260: the reason sits under the item in the menu, not on hover.
    expect(item.parentElement).toHaveTextContent(/only active language lane/i)
    expect(onSetLaneArchived).not.toHaveBeenCalled()
  })

  it("refuses an extra lane too when it is the only active one left", () => {
    renderLanes([{ ...DEFAULT_LANE, archivedAt: "2026-10-03T00:00:00.000Z" }, SPANISH])
    openRowMenu("lane-es")
    expect(screen.getByTestId("archive-lane-lane-es")).toHaveAttribute("aria-disabled", "true")
  })

  it("still shows the permission reason, not the last-lane one, when the user cannot edit", async () => {
    renderLanes([DEFAULT_LANE, SPANISH], false)
    const menu = screen.getByTestId("lane-menu-lane-default")
    expect(menu.hasAttribute("disabled")).toBe(true)
    expect(screen.getByTestId("languages-view-only")).toHaveTextContent(/project lead/i)
  })
})

// AQU-1784: two lanes may read the same string — the same language with no
// name override on either, or the same name typed twice. The switcher numbers
// them; this screen has to say the same thing, and it must let a maintainer
// deliberately create the second one instead of refusing it after the fact.
describe("LanguagesSection — lanes that read the same (AQU-1784)", () => {
  const TSHANGLA_A: ProjectLaneView = {
    id: "lane-a",
    role: "target",
    language: "Tshangla",
    name: null,
    langCode: null,
    legacyTag: "Tshangla",
    position: 1,
    archivedAt: null,
  }
  const TSHANGLA_B: ProjectLaneView = { ...TSHANGLA_A, id: "lane-b", legacyTag: "a3f09c1e", position: 2 }
  const SOURCE: ProjectLaneView = {
    id: "lane-source",
    role: "source",
    language: "English",
    name: null,
    langCode: null,
    legacyTag: null,
    position: 0,
    archivedAt: null,
  }

  function renderLanes(
    lanes: ProjectLaneView[],
    onCreateLane = vi.fn(async () => "ok" as const),
    canEdit = true,
  ) {
    const onSetLaneArchived = vi.fn(async () => true)
    renderWithTooltips(
      <LanguagesSection
        defaultTargetLanguage="Tshangla"
        targetLanes={["Tshangla"]}
        canEdit={canEdit}
        disabledTooltip={canEdit ? null : "You need Project Lead to change languages."}
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
        laneRecords={lanes}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={onCreateLane}
        onSetLaneArchived={onSetLaneArchived}
      />,
    )
    return { onCreateLane, onSetLaneArchived }
  }

  it("says how the numbered lane is shown behind its (i), and nothing on the one that reads plainly", async () => {
    // The first colliding lane keeps the bare label, which its own name
    // already shows — so only the suffixed one carries the note.
    renderLanes([SOURCE, TSHANGLA_A, TSHANGLA_B])
    expect(screen.queryByTestId("lane-shown-as-lane-a")).toBeNull()
    const hint = screen.getByTestId("lane-shown-as-lane-b")
    expect(hint).toHaveAccessibleName('Shown as "Tshangla · 2"')
    await expectInPlaceInfo(hint, 'Shown as "Tshangla · 2"')
  })

  it("prefers a colliding lane's code override to its position", () => {
    renderLanes([SOURCE, TSHANGLA_A, { ...TSHANGLA_B, langCode: "tsj" }])
    expect(screen.getByTestId("lane-shown-as-lane-b")).toHaveAccessibleName('Shown as "Tshangla · tsj"')
  })

  it("says nothing on a lane whose label is already unique", () => {
    renderLanes([SOURCE, TSHANGLA_A, { ...TSHANGLA_B, language: "Dzongkha" }])
    expect(screen.queryByTestId("lane-shown-as-lane-a")).toBeNull()
    expect(screen.queryByTestId("lane-shown-as-lane-b")).toBeNull()
    expect(screen.queryByTestId("lane-duplicate-warning")).toBeNull()
    expect(screen.queryByTestId("lane-same-name-lane-a")).toBeNull()
  })

  it("warns above the table when two languages share a name, and marks both rows", () => {
    renderLanes([SOURCE, TSHANGLA_A, TSHANGLA_B])
    expect(screen.getByTestId("lane-duplicate-warning").textContent).toContain(
      'Two language lanes are both named "Tshangla"',
    )
    expect(screen.getByTestId("lane-same-name-lane-a").textContent).toBe("Same name as another language lane")
    expect(screen.getByTestId("lane-same-name-lane-b")).toBeTruthy()
  })

  it("Rename the second one opens the second language's fields on its name", () => {
    renderLanes([SOURCE, TSHANGLA_A, TSHANGLA_B])
    fireEvent.click(screen.getByTestId("lane-duplicate-rename"))
    expect(screen.getByTestId("lane-edit-lane-b")).toBeTruthy()
    expect(screen.queryByTestId("lane-edit-lane-a")).toBeNull()
    expect(screen.getByTestId("lane-name-input-lane-b")).toHaveFocus()
  })

  it("Archive it asks before archiving the second one, with its last-change line", async () => {
    const { onSetLaneArchived } = renderLanes([SOURCE, TSHANGLA_A, TSHANGLA_B])
    fireEvent.click(screen.getByTestId("lane-duplicate-archive"))
    expect(screen.getByTestId("archive-confirm-lane-b")).toBeTruthy()
    expect(onSetLaneArchived).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /confirm archive/i }))
    await waitFor(() => expect(onSetLaneArchived).toHaveBeenCalledWith("lane-b", true))
  })

  it("keeps the warning's actions disabled, with the reason, for someone who may not edit", async () => {
    renderLanes([SOURCE, TSHANGLA_A, TSHANGLA_B], undefined, false)
    const rename = screen.getByTestId("lane-duplicate-rename")
    expect(rename).toBeDisabled()
    expect(screen.getByTestId("lane-duplicate-archive")).toBeDisabled()
    expect(screen.getByTestId("languages-view-only")).toHaveTextContent(/project lead/i)
  })

  it("warns inline while a duplicate name is typed, before anything is saved", () => {
    const { onCreateLane } = renderLanes([SOURCE, TSHANGLA_A])
    openAddForm()
    expect(screen.queryByTestId("add-lane-duplicate-notice")).toBeNull()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Tshangla" } })
    expect(screen.getByTestId("add-lane-duplicate-notice").textContent).toContain("Tshangla")
    expect(onCreateLane).not.toHaveBeenCalled()
  })

  it("still adds the warned duplicate, telling the server it was warned about", async () => {
    const { onCreateLane } = renderLanes([SOURCE, TSHANGLA_A])
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Tshangla" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Tshangla",
        code: null,
        allowDuplicateName: true,
      }),
    )
  })

  it("does not warn, or waive the refusal, for a name that is not taken", async () => {
    const { onCreateLane } = renderLanes([SOURCE, TSHANGLA_A])
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Dzongkha" } })
    expect(screen.queryByTestId("add-lane-duplicate-notice")).toBeNull()
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Dzongkha",
        code: null,
        allowDuplicateName: false,
      }),
    )
  })

  it("compares what the lane will SHOW, so a name override decides the collision", () => {
    // A typed name is what the lane displays, so "Tshangla" as the language
    // with a different name does not collide, and a name matching an existing
    // lane's display does.
    renderLanes([SOURCE, TSHANGLA_A])
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Tshangla" } })
    fireEvent.change(screen.getByTestId("add-lane-name-input"), { target: { value: "Tshangla East" } })
    expect(screen.queryByTestId("add-lane-duplicate-notice")).toBeNull()
    fireEvent.change(screen.getByTestId("add-lane-name-input"), { target: { value: "tshangla" } })
    expect(screen.getByTestId("add-lane-duplicate-notice")).toBeTruthy()
  })

  it("does not warn about an ARCHIVED lane of the same name", () => {
    // Restoring it is what the maintainer wants, so the server's refusal
    // stands and this screen does not waive it.
    renderLanes([SOURCE, { ...TSHANGLA_A, archivedAt: "2026-10-01T00:00:00Z" }, TSHANGLA_B])
    // One active Tshangla: no warning above the table.
    expect(screen.queryByTestId("lane-duplicate-warning")).toBeNull()
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Tshangla" } })
    // lane-b is active and reads the same, so the notice is about lane-b…
    expect(screen.getByTestId("add-lane-duplicate-notice")).toBeTruthy()
  })
})

// Media redesign slice 1 (Sam, Oct 22): each language row says what it
// delivers — Text, Audio, or Text and audio — in place of AQU-1954's
// "Records audio" switch.
describe("LanguagesSection — Delivers per language", () => {
  const GERMAN: ProjectLaneView = {
    id: "lane-de", role: "target", name: "German", langCode: "de", legacyTag: "", position: 0, archivedAt: null,
    recordsAudio: false, delivers: "text",
  }
  const TOK_PISIN: ProjectLaneView = {
    id: "lane-tpi", role: "target", name: "Tok Pisin", langCode: "tpi", legacyTag: "tpi", position: 1, archivedAt: null,
    recordsAudio: false, delivers: "audio",
  }
  // A language that had "Records audio" on: migration 0187 leaves it unchosen.
  const SWAHILI: ProjectLaneView = {
    id: "lane-sw", role: "target", name: "Swahili", langCode: "sw", legacyTag: "sw", position: 2, archivedAt: null,
    recordsAudio: true, delivers: null,
  }

  function renderRows(
    onSetLaneDelivers?: (laneId: string, delivers: LaneDelivers) => Promise<LaneDeliversOutcome>,
    canEdit = true,
    lanes: ProjectLaneView[] = [GERMAN, TOK_PISIN, SWAHILI],
  ) {
    const onCreateLane = vi.fn(async () => "ok" as const)
    renderWithTooltips(
      <LanguagesSection
        defaultTargetLanguage="German"
        targetLanes={["de", "tpi", "sw"]}
        canEdit={canEdit}
        disabledTooltip={null}
        patch={vi.fn(async (): Promise<PatchOutcome> => ({ kind: "ok" }))}
        laneRecords={lanes}
        onRenameLane={vi.fn(async () => "ok" as const)}
        onCreateLane={onCreateLane}
        onSetLaneArchived={vi.fn(async () => true)}
        onSetLaneDelivers={onSetLaneDelivers}
      />,
    )
    return { onCreateLane }
  }

  async function choose(lane: string, option: string) {
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: `What ${lane} delivers` }))
    await user.click(await screen.findByRole("option", { name: option }))
  }

  it("shows each language's own choice in a Delivers column, explained behind its (i)", async () => {
    renderRows(vi.fn(async () => "ok" as const), true, [GERMAN, TOK_PISIN])
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toContain("Delivers")
    expect(screen.getByRole("combobox", { name: "What German delivers" })).toHaveTextContent("Text")
    expect(screen.getByRole("combobox", { name: "What Tok Pisin delivers" })).toHaveTextContent("Audio")
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.queryByText(/Records audio/)).toBeNull()
    // The explanation is not on the card itself, only behind the (i)
    // (expectInPlaceInfo checks it starts shut).
    await expectInPlaceInfo(
      screen.getByTestId("lane-delivers-hint"),
      /Text and audio: a line is done only when both/,
    )
  })

  it("asks for a choice on a language that had Records audio on, and only there", async () => {
    renderRows(vi.fn(async () => "ok" as const))
    const swahili = screen.getByRole("combobox", { name: "What Swahili delivers" })
    expect(swahili).toHaveTextContent("Choose")
    expect(swahili).toHaveAttribute("data-needs-choice", "true")
    const why = screen.getByTestId("lane-delivers-needs-choice-lane-sw")
    expect(why).toHaveAccessibleName("Why Swahili needs a choice")
    await expectInPlaceInfo(why, /Choose whether it delivers Text, or Text and audio/)
    expect(screen.queryByTestId("lane-delivers-needs-choice-lane-de")).toBeNull()
    expect(screen.queryByTestId("lane-delivers-needs-choice-lane-tpi")).toBeNull()
  })

  it("reads an older server's rows from Records audio: off is Text, on asks", () => {
    const { delivers: _de, ...oldGerman } = GERMAN
    const { delivers: _sw, ...oldSwahili } = SWAHILI
    renderRows(vi.fn(async () => "ok" as const), true, [oldGerman, oldSwahili])
    expect(screen.getByRole("combobox", { name: "What German delivers" })).toHaveTextContent("Text")
    expect(screen.getByRole("combobox", { name: "What Swahili delivers" })).toHaveTextContent("Choose")
  })

  it("saves one language at a time", async () => {
    const save = vi.fn(async () => "ok" as const)
    renderRows(save)
    await choose("German", "Text and audio")
    await waitFor(() => expect(save).toHaveBeenCalledWith("lane-de", "text_and_audio"))
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("snaps back and says why when the save is refused", async () => {
    renderRows(vi.fn(async () => "forbidden" as const))
    await choose("German", "Audio")
    expect(await screen.findByText("You don't have permission to change shared settings.")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "What German delivers" })).toHaveTextContent("Text")
  })

  it("says so when the save fails offline", async () => {
    renderRows(vi.fn(async () => "offline" as const))
    await choose("German", "Audio")
    expect(await screen.findByText("You're offline. Reconnect to save language lanes.")).toBeInTheDocument()
  })

  it("cannot be changed by someone who may not edit languages", () => {
    renderRows(vi.fn(async () => "ok" as const), false)
    expect(screen.getByRole("combobox", { name: "What Tok Pisin delivers" })).toBeDisabled()
  })

  it("is not drawn where there is nothing to save it to", () => {
    renderRows(undefined)
    expect(screen.queryByRole("combobox", { name: /delivers/ })).toBeNull()
    expect(screen.queryByTestId("lane-delivers-hint")).toBeNull()
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Delivers")
    openAddForm()
    expect(screen.queryByTestId("add-lane-delivers")).toBeNull()
  })

  it("lets the add form choose what the new language delivers, Text unless changed", async () => {
    const { onCreateLane } = renderRows(vi.fn(async () => "ok" as const))
    openAddForm()
    const delivers = screen.getByRole("combobox", { name: "What the new language lane delivers" })
    expect(delivers).toHaveTextContent("Text")
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Zulu" } })
    const user = userEvent.setup()
    await user.click(screen.getByRole("combobox", { name: "What Zulu delivers" }))
    await user.click(await screen.findByRole("option", { name: "Audio" }))
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith({
        name: "",
        language: "Zulu",
        code: null,
        allowDuplicateName: false,
        delivers: "audio",
      }),
    )
  })

  it("sends Text for a new language when the add form's Delivers is left alone", async () => {
    const { onCreateLane } = renderRows(vi.fn(async () => "ok" as const))
    openAddForm()
    fireEvent.change(screen.getByTestId("add-target-lang-input"), { target: { value: "Zulu" } })
    fireEvent.click(screen.getByTestId("add-target-lang-btn"))
    await waitFor(() =>
      expect(onCreateLane).toHaveBeenCalledWith(expect.objectContaining({ language: "Zulu", delivers: "text" })),
    )
  })
})

// AQU-2263: Project settings adds a language with the same piece as New Project.
describe("LanguagesSection — the shared Add language piece", () => {
  it("opens the add form from the same Add language button New Project uses", () => {
    renderSection()
    const add = screen.getByTestId("add-lane-open")
    expect(add).toHaveTextContent("Add language lane")
    expect(add).toHaveAttribute("data-add-language")
  })
})
