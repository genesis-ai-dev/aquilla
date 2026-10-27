// AQU-1767: the per-user edit history, who owns Cmd/Ctrl+Z, and (phase 2)
// steps as data, groups, "undo to here", blocked steps and persistence.
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  flushHistorySaveForTests,
  historyReady,
  historyView,
  recordGroup,
  recordStep,
  redoLast,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  setLaneSwitcher,
  setFileNamer,
  setOpenFileProbe,
  undoLast,
  undoTo,
  withGroup,
  type StepHandler,
  type StepOutcome,
} from "./history"
import { clearHistoryStoreForTests, loadLaneHistories, saveLaneHistoryForTests } from "./history-store"
import { setToastUndoAt, undoShortcutOwner } from "./arbiter"

/** A step kind whose undo/redo log what they did, with a scripted outcome. */
function logKind(log: string[], outcomes: Record<string, StepOutcome> = {}): StepHandler<never> {
  return {
    undo: async (d: { name: string }) => {
      log.push(`undo ${d.name}`)
      return outcomes[d.name] ?? { kind: "done" }
    },
    redo: async (d: { name: string }) => {
      log.push(`redo ${d.name}`)
      return { kind: "done" }
    },
  } as StepHandler<never>
}

const step = (name: string, extra: Partial<{ fileId: string; at: number }> = {}) => ({
  kind: "test.log",
  data: { name },
  labelKey: name,
  ...extra,
})

beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  setToastUndoAt(null)
  setHistoryScope("p1", "sam")
  await historyReady()
})

describe("edit history", () => {
  it("presses made while a slow step runs wait their turn instead of being dropped", async () => {
    const log: string[] = []
    let release: () => void = () => {}
    registerStepKinds({
      "test.log": logKind(log),
      "test.slow": {
        undo: () => new Promise<StepOutcome>((resolve) => { release = () => { log.push("undo slow"); resolve({ kind: "done" }) } }),
        redo: async () => ({ kind: "done" }),
      } as StepHandler<never>,
    })
    recordStep(step("a"))
    recordStep(step("b"))
    recordStep({ kind: "test.slow", data: {}, labelKey: "slow" })
    const presses = [undoLast(), undoLast(), undoLast(), undoLast()]
    await new Promise((r) => setTimeout(r, 0))
    release()
    const results = await Promise.all(presses)
    expect(log).toEqual(["undo slow", "undo b", "undo a"])
    expect(results.map((r) => r?.step.labelKey ?? null)).toEqual(["slow", "b", "a", null])
    // Undo then Redo pressed together: the redo waits for the undo, then runs.
    await redoLast()
    const [u, r] = [undoLast(), redoLast()]
    expect((await u)?.step.labelKey).toBe("a")
    expect((await r)?.step.labelKey).toBe("a")
  })

  it("a press does nothing if the user moved to another project before its turn", async () => {
    const log: string[] = []
    let release: () => void = () => {}
    registerStepKinds({
      "test.log": logKind(log),
      "test.slow": {
        undo: () => new Promise<StepOutcome>((resolve) => { release = () => resolve({ kind: "done" }) }),
        redo: async () => ({ kind: "done" }),
      } as StepHandler<never>,
    })
    recordStep(step("b"))
    recordStep({ kind: "test.slow", data: {}, labelKey: "slow" })
    const first = undoLast()
    const second = undoLast()
    await new Promise((r) => setTimeout(r, 0))
    setHistoryScope("p2", "sam")
    release()
    expect((await first)?.step.labelKey).toBe("slow")
    expect(await second).toBeNull()
    expect(log).toEqual([])
  })

  it("a step recorded while its action saves: undo waits for it, and a refused action drops the step", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep(step("a"))
    let landed: (ok: boolean) => void = () => {}
    recordStep(step("hide"), undefined, { pending: new Promise<boolean>((r) => { landed = r }) })
    const press = undoLast()
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual([]) // waits for the hide to land
    landed(true)
    expect((await press)?.step.labelKey).toBe("hide")
    expect(log).toEqual(["undo hide"])

    let refused: (ok: boolean) => void = () => {}
    recordStep(step("remove"), undefined, { pending: new Promise<boolean>((r) => { refused = r }) })
    refused(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(historyView().nextUndo?.labelKey).toBe("a")
  })

  it("a step being undone is saved as undone already, so a reload doesn't offer it again", async () => {
    let release: () => void = () => {}
    registerStepKinds({
      "test.slow": {
        undo: () => new Promise<StepOutcome>((resolve) => { release = () => resolve({ kind: "done" }) }),
        redo: async () => ({ kind: "done" }),
      } as StepHandler<never>,
    })
    recordStep({ kind: "test.slow", data: {}, labelKey: "slow" })
    const pending = undoLast()
    await new Promise((r) => setTimeout(r, 0))
    await flushHistorySaveForTests()
    // A reload now (the undo's writes are out) reads the step as undone.
    resetHistoryForTests()
    setHistoryScope("p1", "sam")
    await historyReady()
    expect(historyView().nextUndo).toBeNull()
    expect(historyView().nextRedo?.labelKey).toBe("slow")
    release()
    await pending
  })

  it("undoes newest first, then redoes it; a new step clears redo", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep(step("a"))
    recordStep(step("b"))
    expect(historyView().nextUndo?.labelKey).toBe("b")
    await undoLast()
    expect(historyView().nextRedo?.labelKey).toBe("b")
    await redoLast()
    expect(log).toEqual(["undo b", "redo b"])
    await undoLast()
    recordStep(step("c"))
    expect(historyView().canRedo).toBe(false)
  })

  it("a skipped step leaves the stack and is logged with its reason", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log, { b: { kind: "skipped", reason: "changed" } }) })
    recordStep(step("a"))
    recordStep(step("b"))
    const r = await undoLast()
    expect(r?.outcome).toEqual({ kind: "skipped", reason: "changed" })
    expect(historyView().canRedo).toBe(false)
    expect(historyView().skipped.map((s) => [s.labelKey, s.reason])).toEqual([["b", "changed"]])
    await undoLast()
    expect(log).toEqual(["undo b", "undo a"])
  })

  it("a step of a kind nobody handles is skipped as unavailable", async () => {
    recordStep({ kind: "nobody.handles", data: {}, labelKey: "x" })
    expect((await undoLast())?.outcome).toEqual({ kind: "skipped", reason: "unavailable" })
  })

  it("a step made in a file that is not open waits on the stack", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep({ ...step("a", { fileId: "file-1" }), fileName: "Genesis 1" })
    setOpenFileProbe((id) => id === "file-2")
    const r = await undoLast()
    expect(r?.outcome).toEqual({ kind: "blocked", reason: "elsewhere" })
    expect(r?.step.fileName).toBe("Genesis 1")
    expect(historyView().canUndo).toBe(true)
    expect(log).toEqual([])
    setOpenFileProbe((id) => id === "file-1")
    expect((await undoLast())?.outcome.kind).toBe("done")
  })

  // Slice 13 evidence (Oct 27): a take renamed in Ruth's Recording tab, undone
  // from another file, said "Open the file it was made in to undo …": the
  // rename is recorded with its file's id and no name. The workspace's namer
  // fills the name in; a step that brings its own name keeps it.
  it("names a step's file from its id when the step brought no name", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    setFileNamer((id) => (id === "file-1" ? "Ruth" : null))
    recordStep(step("c", { fileId: "file-9" }))
    recordStep({ ...step("b", { fileId: "file-1" }), fileName: "Ruth 1" })
    recordStep(step("a", { fileId: "file-1" }))
    expect(historyView().undoSteps.map((s) => s.fileName)).toEqual([null, "Ruth 1", "Ruth"])
    setOpenFileProbe((id) => id === "file-2")
    const r = await undoLast()
    expect(r?.outcome).toEqual({ kind: "blocked", reason: "elsewhere" })
    expect(r?.step.fileName).toBe("Ruth")
  })

  it("keeps one stack per project and person", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep(step("a"))
    setHistoryScope("p2", "sam")
    await historyReady()
    expect(historyView().canUndo).toBe(false)
    expect(await undoLast()).toBeNull()
    setHistoryScope("p1", "sam")
    expect(historyView().canUndo).toBe(true)
  })

  it("records into a named scope that is not the active one", async () => {
    recordStep(step("settings"), { projectId: "p9", username: "sam" })
    expect(historyView().canUndo).toBe(false)
    setHistoryScope("p9", "sam")
    await historyReady()
    expect(historyView().nextUndo?.labelKey).toBe("settings")
  })

  it("the newer of the history and an Undo toast owns Cmd/Ctrl+Z", () => {
    expect(undoShortcutOwner()).toBeNull()
    setToastUndoAt(100)
    expect(undoShortcutOwner()).toBe("toast")
    recordStep(step("a", { at: 200 }))
    expect(undoShortcutOwner()).toBe("history")
    setToastUndoAt(300)
    expect(undoShortcutOwner()).toBe("toast")
  })
})

describe("groups", () => {
  it("withGroup makes one step of everything recorded inside it, undone newest first", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    await withGroup({ labelKey: "bulk" }, async () => {
      recordStep(step("a"))
      await Promise.resolve()
      recordStep(step("b"))
    })
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["bulk"])
    await undoLast()
    expect(log).toEqual(["undo b", "undo a"])
    await redoLast()
    expect(log).toEqual(["undo b", "undo a", "redo a", "redo b"])
  })

  it("a group of one keeps its own name unless asked to stay a group", async () => {
    await withGroup({ labelKey: "bulk" }, async () => recordStep(step("only")))
    expect(historyView().nextUndo?.labelKey).toBe("only")
    await withGroup({ labelKey: "bulk" }, async () => recordStep(step("only")), { alwaysGroup: true })
    expect(historyView().nextUndo?.labelKey).toBe("bulk")
  })

  it("parts changed since are skipped and the rest still go, reported as partial", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log, { b: { kind: "skipped", reason: "changed" } }) })
    recordGroup({ labelKey: "bulk" }, [step("a"), step("b"), step("c")])
    const r = await undoLast()
    expect(r?.outcome).toEqual({ kind: "done", partial: { skipped: 1 } })
    expect(log).toEqual(["undo c", "undo b", "undo a"])
  })

  it("a group whose every part was changed since is skipped", async () => {
    registerStepKinds({ "test.log": logKind([], { a: { kind: "skipped", reason: "changed" } }) })
    recordGroup({ labelKey: "bulk" }, [step("a")])
    expect((await undoLast())?.outcome).toEqual({ kind: "skipped", reason: "changed" })
  })
})

describe("undo to here", () => {
  it("walks back one step at a time, down to and including the one picked", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep(step("a"))
    recordStep(step("b"))
    recordStep(step("c"))
    const target = historyView().undoSteps[1] // "b"
    const results = await undoTo(target.id)
    expect(results.map((r) => r.step.labelKey)).toEqual(["c", "b"])
    expect(log).toEqual(["undo c", "undo b"])
    expect(historyView().nextUndo?.labelKey).toBe("a")
    expect(historyView().redoSteps.map((s) => s.labelKey)).toEqual(["c", "b"])
  })

  it("stops at a step that has to wait for its file", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    recordStep(step("a"))
    recordStep(step("b", { fileId: "other" }))
    recordStep(step("c"))
    setOpenFileProbe((id) => id !== "other")
    const results = await undoTo(historyView().undoSteps[0].id)
    expect(results.map((r) => r.outcome.kind)).toEqual(["done", "blocked"])
    expect(log).toEqual(["undo c"])
  })
})

describe("persistence", () => {
  it("steps come back after a reload, and only for the same person", async () => {
    const log: string[] = []
    recordStep(step("saved-a"))
    recordStep(step("saved-b"))
    await flushHistorySaveForTests()

    resetHistoryForTests() // a reload: nothing in memory
    registerStepKinds({ "test.log": logKind(log) })
    setHistoryScope("p1", "ana")
    await historyReady()
    expect(historyView().canUndo).toBe(false)

    setHistoryScope("p1", "sam")
    await historyReady()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["saved-a", "saved-b"])
    await undoLast()
    expect(log).toEqual(["undo saved-b"])
  })

  it("the per-language histories of before decision 11 join the project's history, stamped with their language", async () => {
    // Gap 27: merged the first time the project opens on this device.
    await saveLaneHistoryForTests("p1", "sam", "Spanish", {
      undo: [{ id: "a", kind: "take.window", data: {}, labelKey: "es-trim", at: 10 }],
      redo: [],
      log: [],
      gone: [],
    })
    await saveLaneHistoryForTests("p1", "sam", "French", {
      undo: [
        { id: "b", kind: "text.commit", data: { side: "target" }, labelKey: "fr-text", at: 20 },
        { id: "c", kind: "row.add", data: {}, labelKey: "fr-row", at: 30 },
      ],
      redo: [],
      log: [],
      gone: [],
    })
    resetHistoryForTests() // a reload after the update
    setHistoryScope("p1", "sam", "French")
    await historyReady()
    expect(historyView().undoSteps.map((s) => [s.labelKey, s.lane])).toEqual([
      ["es-trim", "Spanish"],
      ["fr-text", "French"],
      // A row belongs to every language.
      ["fr-row", undefined],
    ])
    // The old rows are gone: a second reload reads the merged copy alone.
    expect(await loadLaneHistories("p1", "sam")).toEqual([])
  })

  it("saved steps sit under anything recorded before the load finished", async () => {
    recordStep(step("old"))
    await flushHistorySaveForTests()
    resetHistoryForTests()
    setHistoryScope("p1", "sam")
    recordStep(step("new")) // before the read resolves
    await historyReady()
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["old", "new"])
  })
})

// Decision 11 (2026-10-20): one history per person and project, whatever
// language is open; a step still knows its language, and undoing it opens
// that language first (gap 24).
describe("one history per project, every language", () => {
  const laneStep = (name: string) => ({ kind: "test.log", data: { name }, labelKey: name })

  it("undoes the newest step whatever language it was made in, opening that language first", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    const opened: string[] = []
    setLaneSwitcher(async (lane) => {
      opened.push(lane)
      setHistoryScope("p1", "sam", lane) // the workspace re-scopes as the language opens
      return "ready"
    })
    setHistoryScope("p1", "sam", "Swahili")
    recordStep(laneStep("sw-trim"))
    setHistoryScope("p1", "sam", "French")
    recordStep(laneStep("fr-text"))
    expect(historyView().undoSteps.map((s) => [s.labelKey, s.lane])).toEqual([
      ["sw-trim", "Swahili"],
      ["fr-text", "French"],
    ])
    expect((await undoLast())?.step.labelKey).toBe("fr-text")
    expect(opened).toEqual([])
    const second = await undoLast()
    expect(second?.step).toMatchObject({ labelKey: "sw-trim", lane: "Swahili" })
    expect(second?.outcome.kind).toBe("done")
    expect(opened).toEqual(["Swahili"])
    // Redo puts both back, in order; the French one opens French again.
    expect((await redoLast())?.step.labelKey).toBe("sw-trim")
    expect((await redoLast())?.step.labelKey).toBe("fr-text")
    expect(opened).toEqual(["Swahili", "French"])
    expect(log).toEqual(["undo fr-text", "undo sw-trim", "redo sw-trim", "redo fr-text"])
  })

  it("a step every language shares runs where you are, without switching", async () => {
    const log: string[] = []
    registerStepKinds({ "row.add": logKind(log) })
    const switcher = vi.fn(async () => "ready" as const)
    setLaneSwitcher(switcher)
    setHistoryScope("p1", "sam", "Swahili")
    recordStep({ kind: "row.add", data: { name: "row" }, labelKey: "row" })
    setHistoryScope("p1", "sam", "French")
    expect(historyView().undoSteps[0].lane).toBeUndefined()
    expect((await undoLast())?.outcome.kind).toBe("done")
    expect(switcher).not.toHaveBeenCalled()
  })

  it("a language that does not open in time keeps the step; one you may no longer open drops it", async () => {
    const log: string[] = []
    registerStepKinds({ "test.log": logKind(log) })
    setHistoryScope("p1", "sam", "Swahili")
    recordStep(laneStep("sw-a"))
    recordStep(laneStep("sw-b"))
    setHistoryScope("p1", "sam", "French")
    setLaneSwitcher(async () => "blocked")
    expect((await undoLast())?.outcome).toEqual({ kind: "blocked", reason: "language" })
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["sw-a", "sw-b"])
    setLaneSwitcher(async () => "denied")
    expect((await undoLast())?.outcome).toEqual({ kind: "skipped", reason: "notAllowed" })
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["sw-a"])
    expect(historyView().skipped.map((e) => e.reason)).toEqual(["notAllowed"])
    expect(log).toEqual([])
  })

  it("files a step recorded from outside the editor in the project's one history", async () => {
    const log: string[] = []
    registerStepKinds({ "settings.project": logKind(log) })
    setHistoryScope("p1", "sam", "French")
    await historyReady()
    setHistoryScope(null, null)
    // A settings save names only its project and person.
    recordStep({ kind: "settings.project", data: { name: "settings" }, labelKey: "settings" }, { projectId: "p1", username: "sam" })
    setHistoryScope("p1", "sam", "Spanish")
    await historyReady()
    expect((await undoLast())?.step.labelKey).toBe("settings")
  })
})
