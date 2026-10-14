// AQU-1486 — the gestures that validate a repeated row, end to end through the
// hook: what is asked, what is written, and what Undo takes back.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react"
import type { CellData } from "@/hooks/useCells"
import { getRepetitionChoice } from "@/lib/store/repetition-choice-pref"
import {
  useRepetitionValidation,
  type UseRepetitionValidation,
  type UseRepetitionValidationArgs,
} from "./useRepetitionValidation"

const emitted = vi.hoisted(() => ({
  commits: [] as Array<{ cellId: string; value: string; parentId: string | null; propagatedFromCellId?: string }>,
  votes: [] as Array<{ kind: "validate" | "unvalidate"; cellId: string; editEventId: string }>,
}))

vi.mock("@/lib/sync/events-emit", () => ({
  emitTargetCellCommits: vi.fn(async (inputs: Array<{ cellId: string; value: string; parentId: string | null; propagatedFromCellId?: string }>) =>
    inputs.map((input) => {
      emitted.commits.push(input)
      return `commit-${emitted.commits.length}`
    })),
  emitCellValidate: vi.fn(async (input: { cellId: string; editEventId: string }) => {
    emitted.votes.push({ kind: "validate", cellId: input.cellId, editEventId: input.editEventId })
    return "vote"
  }),
  emitCellUnvalidate: vi.fn(async (input: { cellId: string; editEventId: string }) => {
    emitted.votes.push({ kind: "unvalidate", cellId: input.cellId, editEventId: input.editEventId })
    return "unvote"
  }),
}))

interface ToastCall {
  title: string
  description?: string
  actionProps?: { children: string; onClick: () => void }
  data?: { secondaryAction?: { label: string; onClick: () => void } }
}
const toasts = vi.hoisted(() => [] as ToastCall[])
vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn((options: ToastCall) => { toasts.push(options); return "toast" }), close: vi.fn() },
}))

const SOURCE = "Grace and peace to you."
function makeCell(over: Partial<CellData> & { id: string }): CellData {
  return {
    fileId: "f1",
    original: SOURCE,
    translated: "",
    status: "empty",
    activeValidators: [],
    targetEventId: `t-${over.id}`,
    sourceEventId: `s-${over.id}`,
    ...over,
  } as CellData
}

function setup(cells: CellData[], over: Partial<UseRepetitionValidationArgs> = {}) {
  const pending = new Map<string, string>()
  const args: UseRepetitionValidationArgs = {
    enabled: true,
    projectId: "p1",
    username: "me",
    lane: "",
    canCommit: true,
    canValidateRepeats: true,
    getCells: () => cells,
    isWritable: () => true,
    resolveParentId: (cell) => pending.get(cell.id) ?? cell.targetEventId ?? null,
    applyOptimisticTargetEdit: (cellId, patch) => {
      const i = cells.findIndex((c) => c.id === cellId)
      cells[i] = { ...cells[i], translated: patch.value, status: patch.value ? "unvalidated" : "empty" }
    },
    rememberPendingTargetCommit: (cellId, eventId) => { pending.set(cellId, eventId) },
    afterWrite: async () => {},
    ...over,
  }
  const api: { current: UseRepetitionValidation | null } = { current: null }
  function Harness() {
    api.current = useRepetitionValidation(args)
    return <>{api.current.dialogs}</>
  }
  render(<Harness />)
  return api as { current: UseRepetitionValidation }
}

const lastToast = () => toasts[toasts.length - 1]

beforeEach(() => {
  emitted.commits.length = 0
  emitted.votes.length = 0
  toasts.length = 0
  localStorage.clear()
})

describe("useRepetitionValidation", () => {
  it("a typed edit never asks; its toast's Validate all signs the fills off, and Undo reverts them", async () => {
    const cells = [
      makeCell({ id: "seed", translated: "Neema.", status: "validated", activeValidators: ["me"] }),
      makeCell({ id: "r1" }),
      makeCell({ id: "r2", translated: "Old", status: "unvalidated" }),
    ]
    const api = setup(cells)
    await act(() => api.current.handleCellValidated("seed", "typed"))

    expect(screen.queryByTestId("repetition-choice-dialog")).toBeNull()
    expect(emitted.commits.map((c) => [c.cellId, c.value, c.propagatedFromCellId])).toEqual([
      ["r1", "Neema.", "seed"],
      ["r2", "Neema.", "seed"],
    ])
    expect(emitted.votes).toEqual([])
    expect(lastToast().title).toBe("Applied to 2 repeated segments")
    expect(lastToast().data?.secondaryAction?.label).toBe("Validate all")

    await act(async () => { lastToast().data!.secondaryAction!.onClick() })
    // Each vote lands on that row's fill — a vote on any other edit is dropped.
    await waitFor(() => expect(emitted.votes).toEqual([
      { kind: "validate", cellId: "r1", editEventId: "commit-1" },
      { kind: "validate", cellId: "r2", editEventId: "commit-2" },
    ]))
    expect(lastToast().title).toBe("Validated 2 repeated rows")

    // A second click on the same Undo reverts nothing more.
    await act(async () => { lastToast().actionProps!.onClick(); lastToast().actionProps!.onClick() })
    await waitFor(() => expect(emitted.commits.slice(2).map((c) => [c.cellId, c.value, c.parentId])).toEqual([
      ["r1", "", "commit-1"],
      ["r2", "Old", "commit-2"],
    ]))
  })

  it("a click asks; Validate all with Don't ask again is remembered, and later clicks offer Ask me each time", async () => {
    const cells = [
      makeCell({ id: "seed", translated: "Neema.", status: "validated", activeValidators: ["me"] }),
      makeCell({ id: "r1" }),
      makeCell({ id: "same", translated: "Neema.", status: "unvalidated" }),
    ]
    const api = setup(cells)
    let done!: Promise<void>
    act(() => { done = api.current.handleCellValidated("seed", "click") })
    await screen.findByTestId("repetition-choice-dialog")
    expect(screen.getByText(/appears in 2 other rows/)).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "Don't ask again" }))
    fireEvent.click(screen.getByRole("button", { name: "Validate 2 more rows" }))
    await act(() => done)

    // The identical row needs no write, only the vote, on its current edit.
    expect(emitted.commits.map((c) => c.cellId)).toEqual(["r1"])
    expect(emitted.votes).toEqual([
      { kind: "validate", cellId: "r1", editEventId: "commit-1" },
      { kind: "validate", cellId: "same", editEventId: "t-same" },
    ])

    // Remembered for this user on this project only.
    expect([getRepetitionChoice("me", "p1"), getRepetitionChoice("other", "p1"), getRepetitionChoice("me", "p2")])
      .toEqual(["all", null, null])

    // Remembered: the next click validates without asking, and says how to undo that.
    cells.splice(1, 2, makeCell({ id: "r3" }))
    await act(() => api.current.handleCellValidated("seed", "click"))
    expect(screen.queryByTestId("repetition-choice-dialog")).toBeNull()
    expect(emitted.votes.at(-1)).toMatchObject({ kind: "validate", cellId: "r3" })
    expect(lastToast().data?.secondaryAction?.label).toBe("Ask me each time")
    act(() => lastToast().data!.secondaryAction!.onClick())
    expect(localStorage.getItem("aq.repetition-choice.v1")).toBeNull()
  })

  it("never offers Validate all when the caller cannot sign the repeats off", async () => {
    const cells = [
      makeCell({ id: "seed", translated: "Neema.", status: "validated" }),
      makeCell({ id: "r1" }),
    ]
    const api = setup(cells, { canValidateRepeats: false })
    await act(() => api.current.handleCellValidated("seed", "click"))
    expect(screen.queryByTestId("repetition-choice-dialog")).toBeNull()
    expect(emitted.commits.map((c) => c.cellId)).toEqual(["r1"])
    expect(emitted.votes).toEqual([])
    expect(lastToast().data?.secondaryAction).toBeUndefined()
  })

  it("a bulk run asks once, resolves a disagreement by asking, and one Undo reverts the whole gesture", async () => {
    const cells = [
      makeCell({ id: "a1", translated: "Neema.", status: "unvalidated" }),
      makeCell({ id: "a2", translated: "Amani.", status: "unvalidated" }),
      makeCell({ id: "a3" }),
    ]
    const api = setup(cells)
    let prepared: ReturnType<UseRepetitionValidation["prepareBulkRepetitions"]> = null
    act(() => { prepared = api.current.prepareBulkRepetitions(["a1", "a2"]) })
    // A run with repetitions is asked about; one without is answered at once.
    expect(prepared).not.toBeNull()
    expect(api.current.prepareBulkRepetitions(["a3"])).toBeNull()

    await screen.findByTestId("repetition-choice-dialog")
    expect(screen.getByText(/repeat in 1 other row/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Validate 1 more row" }))

    await screen.findByTestId("repetition-conflict-dialog")
    fireEvent.click(screen.getByRole("radio", { name: /Amani\./ }))
    fireEvent.click(screen.getByRole("button", { name: "Use this choice" }))
    const run = await act(async () => prepared)
    expect(run).not.toBeNull()

    // Nothing is written until the run's own votes are in and apply() runs.
    expect(emitted.commits).toEqual([])
    const seedVotes = [
      { cellId: "a1", fileId: "f1", editEventId: "t-a1" },
      { cellId: "a2", fileId: "f1", editEventId: "t-a2" },
    ]
    const outcome = await act(() => run!.apply(seedVotes))
    expect(emitted.commits.map((c) => [c.cellId, c.value, c.propagatedFromCellId])).toEqual([["a3", "Amani.", "a2"]])
    expect(emitted.votes).toEqual([{ kind: "validate", cellId: "a3", editEventId: "commit-1" }])
    expect(outcome).toMatchObject({ validated: 1, filledOnly: 0, skipped: 0 })
    expect(api.current.bulkToastExtras(outcome).note).toBe("Also validated 1 repeated row.")

    await act(() => outcome.undo!())
    // The run's own votes are taken back; the filled row's vote dies with its revert.
    expect(emitted.votes.slice(1)).toEqual([
      { kind: "unvalidate", cellId: "a1", editEventId: "t-a1" },
      { kind: "unvalidate", cellId: "a2", editEventId: "t-a2" },
    ])
    expect(emitted.commits.slice(1).map((c) => [c.cellId, c.value, c.parentId])).toEqual([["a3", "", "commit-1"]])
  })
})
