// AQU-2262 (Sam, Oct 30): "We should have different spheres of what undos are
// doing. So like in settings, it should only be really applying to settings."
// The settings header's Undo, Redo and History panel act only on settings
// steps; Cmd/Ctrl+Z stays the project's newest step.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { act } from "react"
import { HistoryControls } from "./HistoryControls"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import {
  historyReady,
  historyView,
  recordStep,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  undoLast,
  type StepHandler,
} from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import { isSettingsStep } from "@/lib/history/settings-steps"
import { useHistoryShortcuts } from "@/lib/history/useHistory"

const log: string[] = []
const handler = {
  undo: async (d: { name: string; skip?: boolean }) => {
    log.push(`undo ${d.name}`)
    return d.skip ? { kind: "skipped" as const, reason: "changed" as const } : { kind: "done" as const }
  },
  redo: async (d: { name: string }) => {
    log.push(`redo ${d.name}`)
    return { kind: "done" as const }
  },
} as unknown as StepHandler<never>

beforeEach(async () => {
  log.length = 0
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  setHistoryScope("p1", "sam")
  await historyReady()
  registerStepKinds({ "settings.project": handler, "take.place": handler })
})

/** A change made in Project settings ("Change: <setting>"). */
function setting(name: string, extra: Record<string, unknown> = {}) {
  act(() =>
    recordStep({
      kind: "settings.project",
      data: { name, ...extra },
      labelKey: "editor.history.stepChangeSetting",
      labelParams: { setting: name },
      lane: null,
    }),
  )
}

/** A change made on the timeline ("Move take"). */
function moveTake(name: string, extra: Record<string, unknown> = {}) {
  act(() => recordStep({ kind: "take.place", data: { name, ...extra }, labelKey: "editor.history.stepMove", lane: null }))
}

const renderControls = () => renderWithTooltips(<HistoryControls onResult={vi.fn()} match={isSettingsStep} />)
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(() => new Promise((r) => setTimeout(r, 0)))
}

describe("the settings header's Undo acts only on settings", () => {
  it("a timeline step made since doesn't stop the settings Undo, and is still the newest step for Cmd+Z", async () => {
    setting("Smart quotes")
    moveTake("take 1")
    renderControls()
    const undo = screen.getByTestId("settings-undo")
    expect(undo).toBeEnabled()
    await userEvent.click(undo)
    await waitFor(() => expect(log).toEqual(["undo Smart quotes"]))
    // Cmd+Z is still the project's newest step: the take.
    expect(historyView().nextUndo?.labelKey).toBe("editor.history.stepMove")
    renderHook(() => useHistoryShortcuts(() => {}))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true }))
    await settle()
    expect(log).toEqual(["undo Smart quotes", "undo take 1"])
  })

  it("the button never offers a timeline step", async () => {
    // Sam's report: after undoing a setting, the next Undo offered "Move take".
    moveTake("take 1")
    setting("Smart quotes")
    setting("Who can export")
    moveTake("take 2")
    renderControls()
    // The newest step is the take; the button names the newest setting.
    await expectTooltip(screen.getByTestId("settings-undo"), "Undo: Change: Who can export")
    await userEvent.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(log).toEqual(["undo Who can export"]))
    await waitFor(() => expect(screen.getByTestId("settings-undo")).toBeEnabled())
    await userEvent.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(log).toEqual(["undo Who can export", "undo Smart quotes"]))
    // Only takes are left to undo: the button is greyed, not offering one.
    await waitFor(() => expect(screen.getByTestId("settings-undo")).toBeDisabled())
    expect(historyView().canUndo).toBe(true)
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["editor.history.stepMove", "editor.history.stepMove"])
  })

  it("Redo after it brings the setting back", async () => {
    setting("Smart quotes")
    moveTake("take 1")
    renderControls()
    // AppTooltip swaps a disabled button's wrapper, so it is looked up each time.
    const redo = () => screen.getByTestId("settings-redo")
    expect(redo()).toBeDisabled()
    await userEvent.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(redo()).toBeEnabled())
    await expectTooltip(redo(), "Redo: Change: Smart quotes")
    await userEvent.click(redo())
    await waitFor(() => expect(log).toEqual(["undo Smart quotes", "redo Smart quotes"]))
    // It sits on top of Undo again, and the take is still there under it.
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["editor.history.stepMove", "editor.history.stepChangeSetting"])
  })

  it("settings Redo never redoes a timeline step, even after Cmd+Z undid one", async () => {
    setting("Smart quotes")
    moveTake("take 1")
    renderControls()
    await userEvent.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(log).toEqual(["undo Smart quotes"]))
    // Cmd+Z elsewhere: the take is now the next step Redo would bring back.
    await act(() => undoLast())
    expect(historyView().nextRedo?.labelKey).toBe("editor.history.stepMove")
    await userEvent.click(screen.getByTestId("settings-redo"))
    await waitFor(() => expect(log).toEqual(["undo Smart quotes", "undo take 1", "redo Smart quotes"]))
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["editor.history.stepMove"])
    await waitFor(() => expect(screen.getByTestId("settings-redo")).toBeDisabled())
  })

  it("its History panel lists and undoes only settings, and shows only their skips", async () => {
    setting("Smart quotes")
    moveTake("take 1")
    setting("Who can export")
    moveTake("take 2", { skip: true })
    // Cmd+Z elsewhere: the take was changed since, so it is skipped and logged.
    await act(() => undoLast())
    renderControls()
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    const panel = await screen.findByTestId("history-panel")
    const steps = within(panel).getAllByTestId("history-step")
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Change: Who can export"),
      expect.stringContaining("Change: Smart quotes"),
    ])
    expect(within(panel).queryByTestId("history-panel-skipped")).toBeNull()
    // "Undo to here" on the older setting: both settings go, the take stays.
    log.length = 0
    await userEvent.click(within(steps[1]).getByTestId("history-undo-to-here"))
    await waitFor(() => expect(log).toEqual(["undo Who can export", "undo Smart quotes"]))
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["editor.history.stepMove"])
    const redone = await within(panel).findAllByTestId("history-redo-step")
    expect(redone.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Change: Smart quotes"),
      expect.stringContaining("Change: Who can export"),
    ])
  })

  it("its History panel shows a setting that was skipped, and why", async () => {
    setting("Smart quotes", { skip: true })
    renderControls()
    await userEvent.click(screen.getByTestId("settings-undo"))
    await waitFor(() => expect(log).toEqual(["undo Smart quotes"]))
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    const skipped = await screen.findByTestId("history-panel-skipped")
    expect(skipped).toHaveTextContent("Change: Smart quotes")
  })
})
