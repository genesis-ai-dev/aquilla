/**
 * AQU-1497: the Agent workbench's Target pane has two human validation
 * gestures — the validation control and a typed translation the commit path
 * auto-validates — and neither reached the hook the workspace uses to fill a
 * file's repeated source segments (AQU-1391). A translator validated a cell in
 * the workbench and the repetitions stayed "Not translated", while the same
 * click in the text editor filled them.
 *
 * These render the real pane + TranslatedEditor + TargetValidationControl and
 * pin WHEN the pane hands a cell to `onCellValidated`:
 *
 *   - the validation control: immediately, and only on the way IN;
 *   - a typed edit: once the edit is SETTLED (the editor is left), never from
 *     an idle save with the caret still in the cell (the AQU-1484 rule).
 *
 * WHAT gets filled is the planner's business (repetition-propagation.test.ts);
 * these tests own the trigger.
 */

import { describe, it, expect, afterEach, vi, type Mock } from "vitest"
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { AgentContextPane, type AgentTargetCommitOutcome, type AgentWorkbenchCell } from "./AgentContextPane"
import type { TranslatedEditorCommit } from "../TranslatedEditor"

afterEach(cleanup)

const REPEATED: AgentWorkbenchCell = {
  cellId: "cell-1",
  fileId: "file-1",
  ref: "GEN 1:1",
  source: "Grace and peace to you.",
  target: "old",
  status: "unvalidated",
  validationStatus: "none",
  activeValidators: [],
  validationHistory: [],
  canValidate: true,
}

type MountedEditor = HTMLElement & { editor?: Editor }

interface PaneHandlers {
  onCellValidated: Mock<(cellId: string) => unknown>
  onCommitTarget: Mock<(cellId: string, snapshot: TranslatedEditorCommit) => Promise<AgentTargetCommitOutcome>>
  onValidationChange: Mock<(cellId: string, validated: boolean) => Promise<boolean>>
}

function renderPane(
  handlers: PaneHandlers,
  cell: AgentWorkbenchCell = REPEATED,
) {
  return render(
    <AgentContextPane
      kind="target"
      cells={[cell]}
      language="fr"
      fileName="repetition-agent-repro.txt"
      editable
      currentUsername="alice"
      validationRequirement={1}
      canValidate
      onCommitTarget={handlers.onCommitTarget}
      onValidationChange={handlers.onValidationChange}
      onCellValidated={handlers.onCellValidated}
    />,
  )
}

/** An auto-validating commit path, as a project allowing self-validation has. */
function handlers(overrides: Partial<PaneHandlers> = {}): PaneHandlers {
  return {
    onCellValidated: vi.fn(),
    onCommitTarget: vi.fn(async () => ({ autoValidated: true })),
    onValidationChange: vi.fn(async () => true),
    ...overrides,
  }
}

/** Click the cell's target into edit mode and hand back the focused editor. */
async function openEditor(): Promise<MountedEditor> {
  const readSurface = await waitFor(() => {
    const el = document.querySelector('[data-editor-cell-surface="target-read"]')
    if (!el) throw new Error("read surface not rendered yet")
    return el
  })
  fireEvent.click(readSurface)
  const pm = await waitFor(() => {
    const el = document.querySelector(".ProseMirror") as MountedEditor | null
    if (!el?.editor) throw new Error("editor not mounted yet")
    return el
  })
  act(() => { fireEvent.focus(pm) })
  return pm
}

describe("AgentContextPane — AQU-1497 the workbench's validation control fills repetitions", () => {
  it("hands the cell to onCellValidated when the translator clicks the check", async () => {
    const h = handlers()
    renderPane(h)

    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))

    await waitFor(() => expect(h.onValidationChange).toHaveBeenCalledWith("cell-1", true))
    await waitFor(() => expect(h.onCellValidated).toHaveBeenCalledTimes(1))
    expect(h.onCellValidated).toHaveBeenCalledWith("cell-1")
  })

  it("fills nothing when the translator REMOVES their validation", async () => {
    const h = handlers()
    renderPane(h, { ...REPEATED, validationStatus: "full-self", activeValidators: ["alice"] })

    fireEvent.click(await screen.findByRole("button", { name: /Validated/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Remove your validation" }))

    await waitFor(() => expect(h.onValidationChange).toHaveBeenCalledWith("cell-1", false))
    await act(async () => { await vi.mocked(h.onValidationChange).mock.results[0].value })
    expect(h.onCellValidated).not.toHaveBeenCalled()
  })

  it("fills nothing when the workspace refuses the validation (out of scope, role, enqueue failure)", async () => {
    const h = handlers({ onValidationChange: vi.fn(async () => false) })
    renderPane(h)

    fireEvent.click(await screen.findByRole("button", { name: /Click to validate/ }))

    await waitFor(() => expect(h.onValidationChange).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.mocked(h.onValidationChange).mock.results[0].value })
    expect(h.onCellValidated).not.toHaveBeenCalled()
  })
})

describe("AgentContextPane — AQU-1497 a typed, auto-validated workbench edit fills repetitions", () => {
  it("fires once the translator types and leaves the cell", async () => {
    const h = handlers()
    renderPane(h)
    const pm = await openEditor()

    act(() => { pm.editor!.commands.setContent("mine") })
    act(() => { fireEvent.blur(pm) })

    await waitFor(() => expect(h.onCommitTarget).toHaveBeenCalledTimes(1))
    expect(vi.mocked(h.onCommitTarget).mock.calls[0][0]).toBe("cell-1")
    expect(vi.mocked(h.onCommitTarget).mock.calls[0][1]).toMatchObject({ value: "mine" })
    await waitFor(() => expect(h.onCellValidated).toHaveBeenCalledTimes(1))
    expect(h.onCellValidated).toHaveBeenCalledWith("cell-1")
  })

  it("holds back while the caret is still in the cell — an idle save must not broadcast half-typed text — then fires once on leaving", async () => {
    const h = handlers()
    renderPane(h)
    const pm = await openEditor()

    act(() => { pm.editor!.commands.setContent("half-typ") })
    // The editor's own idle window elapses with focus still in the cell: the
    // text is committed and auto-validated, exactly as before…
    await waitFor(() => expect(h.onCommitTarget).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(vi.mocked(h.onCommitTarget).mock.calls[0][1]).toMatchObject({ value: "half-typ" })
    await act(async () => { await vi.mocked(h.onCommitTarget).mock.results[0].value })
    // …but the repetitions are not touched yet.
    expect(h.onCellValidated).not.toHaveBeenCalled()

    // Leaving the cell — with nothing new to commit — settles the edit.
    act(() => { fireEvent.blur(pm) })
    await waitFor(() => expect(h.onCellValidated).toHaveBeenCalledTimes(1))
    expect(h.onCellValidated).toHaveBeenCalledWith("cell-1")
    expect(h.onCommitTarget).toHaveBeenCalledTimes(1)
  })

  it("fires nothing when the commit path did not validate the edit (self-validation disabled on the project)", async () => {
    const h = handlers({ onCommitTarget: vi.fn(async () => ({ autoValidated: false })) })
    renderPane(h)
    const pm = await openEditor()

    act(() => { pm.editor!.commands.setContent("mine") })
    act(() => { fireEvent.blur(pm) })

    await waitFor(() => expect(h.onCommitTarget).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.mocked(h.onCommitTarget).mock.results[0].value })
    expect(h.onCellValidated).not.toHaveBeenCalled()
  })

  it("fires nothing when a cell is opened and left without an edit", async () => {
    const h = handlers()
    renderPane(h)
    const pm = await openEditor()

    act(() => { fireEvent.blur(pm) })

    // Nothing changed, so the editor has nothing to commit and owes nothing.
    await act(async () => { await Promise.resolve() })
    expect(h.onCommitTarget).not.toHaveBeenCalled()
    expect(h.onCellValidated).not.toHaveBeenCalled()
  })
})
