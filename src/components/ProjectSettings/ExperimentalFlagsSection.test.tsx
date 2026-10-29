import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import { ExperimentalFlagsSection } from "./ExperimentalFlagsSection"
import * as projectIndex from "@/lib/store/project-index"
import { createProject, getProject, _resetDbForTesting } from "@/lib/store/project-index"
import { FLAGS, isAutopilotVisible, isFlagEnabled } from "@/lib/features/flags"
import { ROLE } from "@/lib/frontier/roles"
import { en } from "@/lib/i18n/messages/en"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/components/checking/CheckingLinkCreator", () => ({ CheckingLinkCreator: () => <div>Checking link creator</div> }))

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

const AUTOPILOT_SWITCH = { name: "Try Autopilot" } as const

beforeEach(async () => {
  cleanup()
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("ExperimentalFlagsSection — community checking (AQU-1249)", () => {
  it("keeps checking WIP off until explicitly enabled and persists the flag", async () => {
    await createProject(makeProject())
    render(<ExperimentalFlagsSection projectId="p1" />)
    const toggle = await screen.findByRole("switch", { name: "Community checking (WIP)" })
    expect(toggle).not.toBeChecked()
    expect(screen.queryByText("Checking link creator")).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(await screen.findByText("Checking link creator")).toBeVisible()
    await waitFor(async () => expect(isFlagEnabled((await getProject("p1"))!, "communityChecking")).toBe(true))
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.queryByText("Checking link creator")).not.toBeInTheDocument())
  })
})

describe("ExperimentalFlagsSection — a toggle made before the seed read lands (AQU-1947)", () => {
  // The section seeds its device-local flags from one IDB read at mount. On a
  // loaded machine that read can resolve after the user's first click, carrying
  // a snapshot taken before the click's write. These hold the read on a
  // deferred promise so the late landing happens every run, not one in a
  // thousand.
  const CHECKING_SWITCH = { name: "Community checking (WIP)" } as const

  function holdSeedRead() {
    let land!: (record: ProjectRecord | undefined) => void
    const pending = new Promise<ProjectRecord | undefined>((resolve) => { land = resolve })
    vi.spyOn(projectIndex, "getProject").mockReturnValueOnce(pending)
    return (record: ProjectRecord | undefined) => act(async () => { land(record) })
  }

  const storedFlag = async () => isFlagEnabled((await getProject("p1"))!, "communityChecking")

  afterEach(() => { vi.restoreAllMocks() })

  it("a pre-click snapshot landing after the click leaves the switch on, matching the stored flag", async () => {
    await createProject(makeProject())
    const preClick = await getProject("p1")
    const landSeed = holdSeedRead()
    render(<ExperimentalFlagsSection projectId="p1" />)
    const toggle = await screen.findByRole("switch", CHECKING_SWITCH)
    fireEvent.click(toggle)
    await waitFor(async () => expect(await storedFlag()).toBe(true))

    await landSeed(preClick)
    expect(toggle).toBeChecked()
    expect(screen.getByText("Checking link creator")).toBeVisible()

    // The CI failure: with the switch reverted to off, this second click
    // turned the flag back ON instead of off.
    fireEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(screen.queryByText("Checking link creator")).not.toBeInTheDocument()
    await waitFor(async () => expect(await storedFlag()).toBe(false))
  })

  it("a post-first-write snapshot landing after the second click leaves the switch off, matching the stored flag", async () => {
    await createProject(makeProject())
    const landSeed = holdSeedRead()
    render(<ExperimentalFlagsSection projectId="p1" />)
    const toggle = await screen.findByRole("switch", CHECKING_SWITCH)
    fireEvent.click(toggle)
    await waitFor(async () => expect(await storedFlag()).toBe(true))
    const postFirstWrite = await getProject("p1")
    fireEvent.click(toggle)
    await waitFor(async () => expect(await storedFlag()).toBe(false))

    await landSeed(postFirstWrite)
    expect(toggle).not.toBeChecked()
    expect(screen.queryByText("Checking link creator")).not.toBeInTheDocument()
  })

  it("the late seed still fills every stored flag the user has not touched", async () => {
    // The seed yields only on the keys the user set; it is not skipped outright.
    await createProject(makeProject({ experimentalFlags: { smartEdits: true } }))
    const stored = await getProject("p1")
    const landSeed = holdSeedRead()
    render(<ExperimentalFlagsSection projectId="p1" />)
    fireEvent.click(await screen.findByRole("switch", CHECKING_SWITCH))

    await landSeed(stored)
    expect(screen.getByRole("switch", CHECKING_SWITCH)).toBeChecked()
    expect(screen.getByRole("switch", { name: "Smart edits" })).toBeChecked()
  })

  it("moving to another project shows that project's stored flags, not the previous one's toggles", async () => {
    // The route reuses this component across /project/:id/settings, so a
    // toggle in one project must not outrank the next project's seed.
    await createProject(makeProject())
    await createProject(makeProject({ id: "p2", experimentalFlags: { communityChecking: false } }))
    const p2 = await getProject("p2")
    const { rerender } = render(<ExperimentalFlagsSection projectId="p1" />)
    fireEvent.click(await screen.findByRole("switch", CHECKING_SWITCH))
    await waitFor(async () => expect(await storedFlag()).toBe(true))

    const landSeed = holdSeedRead()
    rerender(<ExperimentalFlagsSection projectId="p2" />)
    await landSeed(p2)
    expect(screen.getByRole("switch", CHECKING_SWITCH)).not.toBeChecked()
    expect(screen.queryByText("Checking link creator")).not.toBeInTheDocument()
  })
})

describe("ExperimentalFlagsSection — Autopilot opt-in (AQU-1246)", () => {
  it("renders the project-wide Autopilot switch OFF when the project has never opted in", async () => {
    // The whole point of the ticket: a project nobody opted in shows an OFF
    // switch here and no Autopilot anywhere else.
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.OWNER}
        onSetAutopilotEnabled={() => {}}
      />,
    )
    const toggle = await screen.findByRole("switch", AUTOPILOT_SWITCH)
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeEnabled()
    expect(isAutopilotVisible({})).toBe(false)
  })

  it("no longer renders the legacy device-local 'Show Autopilot controls' toggle", async () => {
    // AQU-1246 regression guard. This switch WAS the entire gate: device-local,
    // available to every member, one click from ON. It must not come back — a
    // project's Autopilot is opted into project-wide by a lead or above, or
    // not at all.
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.OWNER}
        onSetAutopilotEnabled={() => {}}
      />,
    )
    await screen.findByRole("switch", AUTOPILOT_SWITCH)
    expect(screen.queryByRole("switch", { name: "Show Autopilot controls" })).toBeNull()
    // …and it is absent because the registry entry is marked legacy, not
    // because the key was deleted — deleting it would strand the grandfather.
    expect(FLAGS.contextualTranslation.legacy).toBe(true)
  })

  it("an owner/lead flipping the switch writes the project-wide setting", async () => {
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.PROJECT_LEAD}
        onSetAutopilotEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", AUTOPILOT_SWITCH)
    fireEvent.click(toggle)
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(true))
  })

  it("an opted-in project shows the switch ON and can be switched back off", async () => {
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.MAINTAINER}
        autopilotEnabled
        onSetAutopilotEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", AUTOPILOT_SWITCH)
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(false))
  })

  it("below project_lead the switch is disabled and cannot opt the project in", async () => {
    // The client half of the role gate. The server is authoritative
    // (auth-worker project-settings.ts), but a contributor must not be handed
    // a control that would 403.
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.CONTRIBUTOR}
        onSetAutopilotEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", AUTOPILOT_SWITCH)
    // base-ui's Switch is a span with a visually-hidden input, so the disabled
    // state a user (or a screen reader) meets is the ARIA one.
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(toggle)
    expect(onSet).not.toHaveBeenCalled()
  })

  it("an unsynced local project keeps the switch usable — no roster to protect", async () => {
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={null}
        onSetAutopilotEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", AUTOPILOT_SWITCH)
    expect(toggle).toBeEnabled()
    fireEvent.click(toggle)
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(true))
  })
})

describe("ExperimentalFlagsSection — Smart Extensions switch (AQU-1937)", () => {
  // The whole Smart Extensions surface (extensions page, dock tab, editor bar,
  // palette, "Edit with", import/export contributions, the first-party
  // installs, and every auth-worker /tools* route) hangs off ONE project-wide,
  // server-stored switch, offered here and nowhere else. These pin the client
  // half: off by default, Maintainer+ to flip, written through the shared
  // settings PATCH. The server half (403 `smart_extensions_off` while off) is
  // auth-worker's tools-routes.test.ts; the end-to-end walk is
  // e2e/specs/tools/smart-extensions-flag-importer.spec.ts.
  const EXTENSIONS_SWITCH = { name: "Smart Extensions" } as const

  it("renders the switch OFF in the Experimental group when the project never opted in", async () => {
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.MAINTAINER}
        onSetSmartExtensionsEnabled={() => {}}
      />,
    )
    const toggle = await screen.findByRole("switch", EXTENSIONS_SWITCH)
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeEnabled()
    // It sits in the same Experimental group as the Autopilot opt-in — one
    // place for every experiment, not a switch of its own somewhere else.
    expect(document.getElementById("section-experimental")).toContainElement(toggle)
  })

  it("a maintainer flipping the switch writes the project-wide setting", async () => {
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.MAINTAINER}
        onSetSmartExtensionsEnabled={onSet}
      />,
    )
    fireEvent.click(await screen.findByRole("switch", EXTENSIONS_SWITCH))
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(true))
  })

  it("an opted-in project shows the switch ON and can be switched back off", async () => {
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.OWNER}
        smartExtensionsEnabled
        onSetSmartExtensionsEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", EXTENSIONS_SWITCH)
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(false))
  })

  it("below maintainer the switch is disabled and cannot opt the project in", async () => {
    // The ordinary settings floor (SETTINGS_EDIT_ROLE_FLOOR = maintainer), one
    // step above the Autopilot opt-in's project_lead. The server refuses the
    // write either way; a lead must not be handed a control that would 403.
    const onSet = vi.fn()
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.PROJECT_LEAD}
        onSetSmartExtensionsEnabled={onSet}
      />,
    )
    const toggle = await screen.findByRole("switch", EXTENSIONS_SWITCH)
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(toggle)
    expect(onSet).not.toHaveBeenCalled()
  })

  it("a surface with no settings hook renders the switch read-only", async () => {
    // Same courtesy as the Autopilot row: the Dashboard's copy of this section
    // has no shared-settings PATCH, so the switch shows the stored value and
    // nothing else.
    await createProject(makeProject())
    render(<ExperimentalFlagsSection projectId="p1" roleLevel={ROLE.OWNER} smartExtensionsEnabled />)
    const toggle = await screen.findByRole("switch", EXTENSIONS_SWITCH)
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAttribute("aria-disabled", "true")
  })
})

describe("ExperimentalFlagsSection — who each switch affects (AQU-2053)", () => {
  function rowText(name: string): string {
    const toggle = screen.getByRole("switch", { name })
    const row = toggle.closest("div.flex")
    expect(row).not.toBeNull()
    return row?.textContent ?? ""
  }

  it("says a switch stays on this device only when that switch really does", async () => {
    await createProject(makeProject())
    render(
      <ExperimentalFlagsSection
        projectId="p1"
        roleLevel={ROLE.OWNER}
        onSetAutopilotEnabled={() => {}}
        onSetSmartExtensionsEnabled={() => {}}
      />,
    )

    expect(en["projectSettings.group.experimentalDescription"]).toBe(
      "Autopilot, extensions, and other early features",
    )
    expect(en["autopilot.settings.experimentalDescription"]).toBe(
      "Early features still in development.",
    )
    expect(await screen.findByText("Early features still in development.")).toBeVisible()
    expect(screen.queryByText(/this device only/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/stays on this device/i)).not.toBeInTheDocument()

    for (const name of ["Try Autopilot", "Smart Extensions"]) {
      expect(rowText(name)).not.toMatch(/this device/i)
    }
    for (const name of [
      "Community checking (WIP)",
      "Agent modes",
      "Smart edits",
      "Harmonizer",
      "Smart edits: AI wording",
      "Bible data enrichments",
    ]) {
      expect(rowText(name)).toMatch(/Only on this device/)
    }
  })
})
