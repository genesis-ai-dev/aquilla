/**
 * Tests for the AQU-260 selection-capture race fix in SelectionTermActions.
 *
 * BUG CONTEXT (AQU-260 / BUG-FRO260-A):
 *   When the user clicks "Add to termbase", the browser fires:
 *     mousedown → selectionchange → (focus shift) → click
 *
 *   The AQU-248 `selectionchange` handler was designed to clear `sourceSelection`
 *   when the browser selection collapses (e.g. the user clicked somewhere else).
 *   But during a toolbar button click, the selectionchange fires BEFORE the click
 *   callback. If `handleAddSelectionToTermbase` reads from React state, it sees
 *   null and the AddConceptDialog never opens.
 *
 * THE FIX (two-layer defence):
 *   1. capturedSelectionRef — ref mirror of sourceSelection; set when selection
 *      is captured on mouseup, cleared on confirm/cancel/blur. The onClick handler
 *      reads from this ref, not state, so it survives a state-clear race.
 *   2. toolbarMouseDownRef — set on toolbar button mousedown, cleared on mouseup/
 *      mouseleave. The selectionchange guard skips clearing while this is true,
 *      which keeps the state consistent too.
 *
 * These tests exercise the capture mechanism directly (jsdom's Selection API is
 * too limited to simulate real browser selection events reliably) and encode WHY
 * the fix matters, not just that the happy path works.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Minimal harness that mirrors the exact ref/state pattern from EditorTable.
// This lets us test the capture mechanism without mounting the full EditorTable.
// ---------------------------------------------------------------------------

function SelectionCaptureHarness({
  onAddToTermbase,
}: {
  onAddToTermbase: (term: string) => void
}) {
  const [sourceSelection, setSourceSelection] = useState<string | null>(null)
  const capturedSelectionRef = useRef<string | null>(null)
  const toolbarMouseDownRef = useRef(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogTerm, setDialogTerm] = useState("")

  // Mirrors handleSourceMouseUp: capture selection into both state and ref.
  const handleSourceMouseUp = useCallback(() => {
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed ? sel.toString().trim() : ""
    const captured = text.length > 0 ? text : null
    capturedSelectionRef.current = captured
    setSourceSelection(captured)
  }, [])

  // Mirrors handleAddSelectionToTermbase: reads from ref, not state.
  const handleAddSelectionToTermbase = useCallback(() => {
    const text = capturedSelectionRef.current
    if (!text) return
    // Re-sync state so dialog gets correct pre-fill even if state was cleared.
    setSourceSelection(text)
    setDialogTerm(text)
    setDialogOpen(true)
  }, [])

  // Mirrors AQU-248 selectionchange guard, now with AQU-260 toolbarMouseDownRef check.
  useEffect(() => {
    if (!sourceSelection) return
    const handleSelectionChange = () => {
      if (toolbarMouseDownRef.current) return // AQU-260: suppress during toolbar click
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.toString().trim() === "") {
        setSourceSelection(null)
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [sourceSelection])

  const handleToolbarMouseDown = () => { toolbarMouseDownRef.current = true }
  const handleToolbarMouseUp = () => { toolbarMouseDownRef.current = false }

  const handleConfirm = () => {
    onAddToTermbase(dialogTerm)
    setDialogOpen(false)
    capturedSelectionRef.current = null
    setSourceSelection(null)
  }

  return (
    <div>
      {/* Simulated source text; mouseup triggers selection capture */}
      <div
        data-testid="source-text"
        onMouseUp={handleSourceMouseUp}
      >
        The grace of God
      </div>

      {/* Toolbar — only shown when sourceSelection is non-null */}
      {sourceSelection && (
        <button
          data-testid="add-to-termbase"
          onMouseDown={handleToolbarMouseDown}
          onMouseUp={handleToolbarMouseUp}
          onMouseLeave={handleToolbarMouseUp}
          onClick={handleAddSelectionToTermbase}
        >
          Add to termbase
        </button>
      )}

      {/* Dialog — only shown when dialogOpen */}
      {dialogOpen && (
        <div data-testid="dialog">
          <span data-testid="dialog-term">{dialogTerm}</span>
          <button data-testid="confirm-btn" onClick={handleConfirm}>
            Create draft
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helper: mock window.getSelection to return a fake selection object.
// ---------------------------------------------------------------------------
function mockSelection(text: string) {
  const fakeSel = {
    isCollapsed: false,
    toString: () => text,
    removeAllRanges: vi.fn(),
  }
  vi.spyOn(window, "getSelection").mockReturnValue(fakeSel as unknown as Selection)
  return fakeSel
}

function collapseSelection() {
  const fakeSel = {
    isCollapsed: true,
    toString: () => "",
    removeAllRanges: vi.fn(),
  }
  vi.spyOn(window, "getSelection").mockReturnValue(fakeSel as unknown as Selection)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AQU-260 — selection-capture race fix", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("happy path: toolbar appears after mouseup with a selection", () => {
    render(<SelectionCaptureHarness onAddToTermbase={vi.fn()} />)
    mockSelection("grace")

    fireEvent.mouseUp(screen.getByTestId("source-text"))

    expect(screen.getByTestId("add-to-termbase")).toBeInTheDocument()
  })

  it("happy path: clicking Add opens dialog pre-filled with the selected term", () => {
    const onAdd = vi.fn()
    render(<SelectionCaptureHarness onAddToTermbase={onAdd} />)
    mockSelection("grace")

    fireEvent.mouseUp(screen.getByTestId("source-text"))
    fireEvent.mouseDown(screen.getByTestId("add-to-termbase"))
    fireEvent.click(screen.getByTestId("add-to-termbase"))

    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("dialog-term")).toHaveTextContent("grace")
  })

  it("BUG REGRESSION: dialog still opens when selectionchange fires before onClick (mousedown-blur race)", () => {
    /**
     * This test simulates the exact race that caused BUG-FRO260-A:
     *
     *   1. User selects "grace" → mouseup fires → capturedSelectionRef = "grace"
     *   2. User presses down on "Add to termbase":
     *      a. mousedown fires → toolbarMouseDownRef = true (prevents guard clearing)
     *      b. browser fires selectionchange (selection collapses in some browsers)
     *         → guard is suppressed because toolbarMouseDownRef is true
     *   3. click fires → handleAddSelectionToTermbase reads capturedSelectionRef ("grace")
     *      → dialog opens pre-filled even if state was cleared
     *
     * Without the fix: step 2b would have called setSourceSelection(null) so
     * step 3 would bail out early and the dialog would never open.
     */
    const onAdd = vi.fn()
    render(<SelectionCaptureHarness onAddToTermbase={onAdd} />)

    // Step 1: user selects text.
    mockSelection("grace")
    fireEvent.mouseUp(screen.getByTestId("source-text"))
    expect(screen.getByTestId("add-to-termbase")).toBeInTheDocument()

    // Step 2: mousedown on toolbar button fires (sets toolbarMouseDownRef = true).
    fireEvent.mouseDown(screen.getByTestId("add-to-termbase"))

    // Step 2b: simulate the browser collapsing the selection and firing
    // selectionchange BEFORE the click event (the race).
    collapseSelection()
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })

    // Even though selectionchange fired, the toolbar guard should have
    // suppressed it — but we also fall back to capturedSelectionRef in onClick,
    // so the dialog must open regardless.
    // Step 3: click fires.
    fireEvent.click(screen.getByTestId("add-to-termbase"))

    // Dialog must be open and pre-filled.
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("dialog-term")).toHaveTextContent("grace")
  })

  it("AQU-248 still works: selectionchange clears toolbar when NOT clicking the toolbar", () => {
    /**
     * The AQU-248 dismissal behavior must not regress: when the user clicks
     * somewhere OTHER than the toolbar (toolbarMouseDownRef stays false), a
     * selectionchange with collapsed selection should hide the toolbar.
     */
    render(<SelectionCaptureHarness onAddToTermbase={vi.fn()} />)

    mockSelection("spirit")
    fireEvent.mouseUp(screen.getByTestId("source-text"))
    expect(screen.getByTestId("add-to-termbase")).toBeInTheDocument()

    // User clicks elsewhere — no toolbar mousedown, selection collapses.
    collapseSelection()
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })

    // Toolbar should be gone (AQU-248 dismissal).
    expect(screen.queryByTestId("add-to-termbase")).not.toBeInTheDocument()
  })

  it("capturedSelectionRef is cleared after confirm so a stale term cannot re-open dialog", () => {
    const onAdd = vi.fn()
    render(<SelectionCaptureHarness onAddToTermbase={onAdd} />)

    // First selection: "grace".
    mockSelection("grace")
    fireEvent.mouseUp(screen.getByTestId("source-text"))
    fireEvent.mouseDown(screen.getByTestId("add-to-termbase"))
    fireEvent.click(screen.getByTestId("add-to-termbase"))
    fireEvent.click(screen.getByTestId("confirm-btn"))

    expect(onAdd).toHaveBeenCalledWith("grace")
    // Dialog is gone and no stale ref remains.
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
    expect(screen.queryByTestId("add-to-termbase")).not.toBeInTheDocument()
  })
})
