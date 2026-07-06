/**
 * ParallelPassagesPanel — FRO-177 replace mode tests.
 *
 * WHY: The replace flow must show an inline diff preview before committing,
 * respect the scope toggle (file vs project), surface the HTML-spanning skip
 * count to the user, and always emit retainValidations=false (FRO-286:
 * "Retain my validations" checkbox was a server no-op and has been removed;
 * the honest copy "Replacing text clears validation" is shown instead).
 * These tests verify intent, not just wiring.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ParallelPassagesPanel, type ReplaceAllPayload } from "./ParallelPassagesPanel"
import type { WorkspaceSearchResult } from "@/lib/search/workspace-index"

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<WorkspaceSearchResult> & { translated: string },
): WorkspaceSearchResult {
  return {
    cellId: "cell-1",
    fileId: "file-1",
    fileName: "Genesis",
    original: "",
    context: "",
    matchedFields: new Set(["translated" as const]),
    matchCount: 1,
    matchedTokens: [],
    snippet: overrides.translated,
    rank: 1,
    ...overrides,
  }
}

/** Minimal props to render the panel open in replace mode. */
function baseProps(
  extra: Partial<Parameters<typeof ParallelPassagesPanel>[0]> = {},
): Parameters<typeof ParallelPassagesPanel>[0] {
  return {
    open: true,
    onOpenChange: vi.fn(),
    mode: "replace",
    scope: "project",
    results: [],
    ...extra,
  }
}

/**
 * Get the "Replace All" / "Replace N" apply button, excluding the mode pill
 * button (which also has "Replace" as text). The apply button has aria-busy.
 */
function getApplyButton() {
  // The apply button is the one with aria-busy attribute.
  const all = screen.getAllByRole("button")
  return all.find((btn) => btn.hasAttribute("aria-busy"))!
}

/** CommandInput renders as a combobox (cmdk); happy-dom names it via placeholder. */
function getFindInput() {
  return screen.getByPlaceholderText(/find in project/i)
}

// ── Smoke ─────────────────────────────────────────────────────────────────────

describe("ParallelPassagesPanel — smoke", () => {
  it("renders the dialog open without crashing", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("shows the replace section header when mode is replace", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    expect(screen.getByText(/replace.*target cells only/i)).toBeInTheDocument()
  })
})

// ── Diff preview ──────────────────────────────────────────────────────────────

describe("ParallelPassagesPanel — diff preview", () => {
  it("renders before and after text for a matched target cell", () => {
    const results = [
      makeResult({ cellId: "c1", fileId: "f1", translated: "hello world" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    // Type a find query that matches the translated text.
    fireEvent.change(getFindInput(), {
      target: { value: "hello" },
    })
    // Type a replace value.
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    // Diff preview list should appear with before and after text.
    const diffList = screen.getByRole("list", { name: /cells to replace/i })
    // before: original text (strikethrough in red)
    expect(within(diffList).getByText("hello world")).toBeInTheDocument()
    // after: replaced text (green)
    expect(within(diffList).getByText("hi world")).toBeInTheDocument()
  })

  it("shows '1 cell affected' label when one cell matches", () => {
    const results = [
      makeResult({ cellId: "c1", translated: "foo bar" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "foo" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "baz" },
    })

    expect(screen.getByText(/1 cell affected/i)).toBeInTheDocument()
  })

  it("shows multi-replacement count label when needle appears multiple times in a cell", () => {
    const results = [
      makeResult({ cellId: "c1", translated: "foo foo foo" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "foo" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "bar" },
    })

    expect(screen.getByText(/3 replacements in this cell/i)).toBeInTheDocument()
  })

  it("skips source-side results (original !== '') and does not include them in the diff", () => {
    const results = [
      // source row — should be excluded from replace candidates
      makeResult({ cellId: "c1", translated: "hello", original: "hello source" }),
      // target row — included
      makeResult({ cellId: "c2", translated: "hello world", original: "" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    // Only c2 (target-side) should produce a diff.
    expect(screen.getByText(/1 cell affected/i)).toBeInTheDocument()
  })

  it("shows no diff rows when the find query does not match any result", () => {
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "xyz" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "abc" },
    })

    expect(screen.queryByText(/cell affected/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("list", { name: /cells to replace/i })).not.toBeInTheDocument()
  })
})

// ── HTML-spanning skip count ──────────────────────────────────────────────────

describe("ParallelPassagesPanel — HTML-spanning skip count", () => {
  it("reports skipped matches when needle spans an HTML tag", () => {
    // The match "oo</b>b" straddles a tag — must be skipped, not replaced.
    const results = [
      makeResult({ cellId: "c1", translated: "<b>foo</b>bar" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "oo</b>b" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "XX" },
    })

    expect(screen.getByText(/1 match.*skipped.*html tag boundary/i)).toBeInTheDocument()
  })

  it("does not show skip note when no HTML-spanning matches exist", () => {
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    expect(screen.queryByText(/html tag boundary/i)).not.toBeInTheDocument()
  })
})

// ── Scope toggle ──────────────────────────────────────────────────────────────

describe("ParallelPassagesPanel — scope toggle", () => {
  it("renders the Project scope tab as active by default", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const scopeTabs = screen.getByRole("tablist", { name: /search scope/i })
    const projectTab = within(scopeTabs).getByRole("tab", { name: "Project" })
    expect(projectTab).toHaveAttribute("aria-selected", "true")
  })

  it("calls onScopeChange when a scope tab is clicked", () => {
    const onScopeChange = vi.fn()
    render(
      <ParallelPassagesPanel
        {...baseProps({ onScopeChange, activeFileId: "file-1" })}
      />,
    )
    const scopeTabs = screen.getByRole("tablist", { name: /search scope/i })
    const fileTab = within(scopeTabs).getByRole("tab", { name: "File" })
    fireEvent.click(fileTab)
    expect(onScopeChange).toHaveBeenCalledWith("file")
  })

  it("disables the File scope tab when there is no activeFileId", () => {
    render(<ParallelPassagesPanel {...baseProps({ activeFileId: undefined })} />)
    const scopeTabs = screen.getByRole("tablist", { name: /search scope/i })
    const fileTab = within(scopeTabs).getByRole("tab", { name: "File" })
    expect(fileTab).toHaveAttribute("aria-disabled", "true")
  })
})

// ── FRO-286: "Retain my validations" removed — honest copy + always-false ────

describe("ParallelPassagesPanel — validation copy (FRO-286)", () => {
  it("does NOT render a 'Retain my validations' checkbox", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    expect(screen.queryByRole("checkbox", { name: /retain my validations/i })).toBeNull()
  })

  it("renders the honest 'clears validation' copy in replace mode", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    expect(
      screen.getByText(/replacing text clears validation/i),
    ).toBeTruthy()
  })

  it("always emits retainValidations=false in the onReplaceAll payload", async () => {
    const onReplaceAll = vi.fn()
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]

    render(
      <ParallelPassagesPanel {...baseProps({ results, onReplaceAll })} />,
    )

    fireEvent.change(getFindInput(), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    fireEvent.click(getApplyButton())

    await waitFor(() => expect(onReplaceAll).toHaveBeenCalledTimes(1))
    const payload = onReplaceAll.mock.calls[0][0] as ReplaceAllPayload
    // retainValidations is pinned to false — the field exists for backward
    // compat with the ProjectWorkspace call site but must never be true
    // (the server never implemented re-anchoring; spec Q25 drops validations
    // on head advance by design).
    expect(payload.retainValidations).toBe(false)
    expect(payload.findQuery).toBe("hello")
    expect(payload.replaceQuery).toBe("hi")
  })
})

// ── Replace button state ──────────────────────────────────────────────────────

describe("ParallelPassagesPanel — Replace button state", () => {
  it("is disabled when there are no matching diffs", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    expect(getApplyButton()).toBeDisabled()
  })

  it("is disabled when isReadOnly=true even with diffs", () => {
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]
    render(<ParallelPassagesPanel {...baseProps({ results, isReadOnly: true })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    expect(getApplyButton()).toBeDisabled()
  })

  it("calls onReplaceAll with diffs including correct before/after values", async () => {
    const onReplaceAll = vi.fn()
    const results = [
      makeResult({ cellId: "c1", fileId: "f1", translated: "hello world" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results, onReplaceAll })} />)

    fireEvent.change(getFindInput(), {
      target: { value: "world" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "earth" },
    })

    fireEvent.click(getApplyButton())

    await waitFor(() => expect(onReplaceAll).toHaveBeenCalledTimes(1))
    const payload = onReplaceAll.mock.calls[0][0] as ReplaceAllPayload
    expect(payload.diffs).toHaveLength(1)
    expect(payload.diffs[0].before).toBe("hello world")
    expect(payload.diffs[0].after).toBe("hello earth")
    expect(payload.totalReplaced).toBe(1)
    expect(payload.totalSkipped).toBe(0)
  })
})
