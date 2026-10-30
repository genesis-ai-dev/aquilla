// AQU-1767 phase 2: the History panel lists your steps, newest first, undoes
// to any point, and shows what was skipped and why.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { act } from "react"
import { HistoryPanel } from "./HistoryPanel"
import { expectTooltip } from "@/test-utils/tooltip"
import {
  historyReady,
  recordStep,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  type StepHandler,
} from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"

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
  registerStepKinds({ "test.step": handler })
})

function add(labelKey: string, data: Record<string, unknown> = {}) {
  act(() => recordStep({ kind: "test.step", data: { name: labelKey, ...data }, labelKey }))
}

describe("HistoryPanel", () => {
  it("lists the steps newest first and undoes down to the one picked", async () => {
    add("editor.history.stepAddRow")
    add("editor.history.stepEditText")
    add("editor.history.stepHideRow")
    const onResult = vi.fn()
    render(<HistoryPanel onResult={onResult} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    const steps = within(await screen.findByTestId("history-panel-steps")).getAllByTestId("history-step")
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Hide row"),
      expect.stringContaining("Edit translation"),
      expect.stringContaining("Add row"),
    ])
    // "Undo to here" on the second: the newest two go, newest first.
    await userEvent.click(within(steps[1]).getByTestId("history-undo-to-here"))
    await waitFor(() => expect(log).toEqual(["undo editor.history.stepHideRow", "undo editor.history.stepEditText"]))
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Can redo")).toBeInTheDocument()
  })

  it("shows a skipped undo with its reason", async () => {
    add("editor.history.stepRetimeRow", { skip: true })
    render(<HistoryPanel onResult={vi.fn()} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    await userEvent.click(screen.getByTestId("history-panel-undo"))
    const skipped = await screen.findByTestId("history-panel-skipped")
    expect(skipped.textContent).toContain("Change row timing")
    expect(skipped.textContent).toContain("Someone changed it afterwards")
  })

  it("names each step's file and language; a step every language shares names none (decision 11)", async () => {
    setHistoryScope("p1", "sam", "sw")
    act(() => recordStep({ kind: "test.step", data: { name: "trim" }, labelKey: "editor.history.stepTrim", fileName: "Ep 1" }))
    setHistoryScope("p1", "sam", "fr")
    act(() => recordStep({ kind: "test.step", data: { name: "text" }, labelKey: "editor.history.stepEditText", fileName: "Ep 1" }))
    act(() => recordStep({ kind: "row.add", data: { name: "row" }, labelKey: "editor.history.stepAddRow", fileName: "Ep 1" }))
    const names: Record<string, string> = { sw: "Swahili", fr: "French" }
    render(<HistoryPanel onResult={vi.fn()} laneName={(tag) => names[tag] ?? tag} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    const steps = within(await screen.findByTestId("history-panel-steps")).getAllByTestId("history-step")
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Add row.*Ep 1(?!.*·)/),
      expect.stringContaining("Edit translationEp 1 · French"),
      expect.stringContaining("Ep 1 · Swahili"),
    ])
  })

  it("shows someone else's approval as the reason a step was left alone", async () => {
    registerStepKinds({
      "test.approved": {
        undo: async () => ({ kind: "skipped" as const, reason: "approved" as const, by: "ben" }),
        redo: async () => ({ kind: "done" as const }),
      } as unknown as StepHandler<never>,
    })
    act(() => recordStep({ kind: "test.approved", data: {}, labelKey: "editor.history.stepRecordTake" }))
    render(<HistoryPanel onResult={vi.fn()} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    await userEvent.click(screen.getByTestId("history-panel-undo"))
    const skipped = await screen.findByTestId("history-panel-skipped")
    expect(skipped.textContent).toContain("Record take")
    expect(skipped.textContent).toContain("ben approved it afterwards")
  })

  // The history follows the person to their other devices, which may run a
  // newer version of the app: a step it recorded can name a message this
  // version doesn't have. The panel still opens and names it.
  it("names a step a newer version of the app made, instead of failing", async () => {
    act(() => recordStep({ kind: "test.step", data: { name: "plain" }, labelKey: "editor.history.stepFromALaterVersion" }))
    act(() =>
      recordStep({ kind: "test.step", data: { name: "parts" }, labelKey: "editor.history.stepFromALaterVersion", labelParams: { count: 2 } }),
    )
    render(<HistoryPanel onResult={vi.fn()} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    const steps = within(await screen.findByTestId("history-panel-steps")).getAllByTestId("history-step")
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining("A change made in a newer version of Aquilla"),
      expect.stringContaining("A change made in a newer version of Aquilla"),
    ])
  })

  it("says so when there is nothing to undo", async () => {
    render(<HistoryPanel onResult={vi.fn()} />)
    await userEvent.click(screen.getByTestId("history-panel-trigger"))
    expect(await screen.findByText(/Nothing to undo yet/)).toBeInTheDocument()
  })

  it("names its button apart from each line's Edit history (AQU-1767)", () => {
    render(<HistoryPanel onResult={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Undo history" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit history" })).toBeNull()
  })

  // Canvas board 55, option E, in every view (Sam, Oct 28): a square like its
  // neighbours, without the count.
  it("is its icon alone, without the count", () => {
    add("editor.history.stepAddRow")
    add("editor.history.stepEditText")
    render(<HistoryPanel onResult={vi.fn()} />)
    expect(screen.getByTestId("history-panel-trigger").textContent).toBe("")
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button.
describe("HistoryPanel — the trigger's hover only names it", () => {
  it("names the undo history and nothing more", async () => {
    render(<HistoryPanel onResult={vi.fn()} />)
    await expectTooltip(screen.getByTestId("history-panel-trigger"), "Undo history")
    expect(screen.getByRole("tooltip").textContent).not.toContain("undo any of your recent steps")
  })
})
