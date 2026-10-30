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
