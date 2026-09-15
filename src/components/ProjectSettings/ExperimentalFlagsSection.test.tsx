import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { ExperimentalFlagsSection } from "./ExperimentalFlagsSection"
import { createProject, _resetDbForTesting } from "@/lib/store/project-index"
import { FLAGS, isAutopilotVisible } from "@/lib/features/flags"
import { ROLE } from "@/lib/frontier/roles"
import type { ProjectRecord } from "@/lib/parsers/types"

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
