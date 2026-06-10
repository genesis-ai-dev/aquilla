/**
 * ParallelPassagesPanel — FRO-177 replace mode tests.
 *
 * WHY: The replace flow must show an inline diff preview before committing,
 * respect the scope toggle (file vs project), thread retainValidations through
 * to the onReplaceAll payload, and surface the HTML-spanning skip count to the
 * user. These tests verify intent, not just wiring.
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
    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
      target: { value: "oo</b>b" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "XX" },
    })

    expect(screen.getByRole("note")).toHaveTextContent(/1 match.*skipped.*html tag boundary/i)
  })

  it("does not show skip note when no HTML-spanning matches exist", () => {
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    expect(screen.queryByRole("note")).not.toBeInTheDocument()
  })
})

// ── Scope toggle ──────────────────────────────────────────────────────────────

describe("ParallelPassagesPanel — scope toggle", () => {
  it("renders the Project scope pill as active by default", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    // aria-pressed=true on the "Project" button in the scope group
    const scopeGroup = screen.getByRole("group", { name: /search scope/i })
    const projectBtn = within(scopeGroup).getByRole("button", { name: "Project" })
    expect(projectBtn).toHaveAttribute("aria-pressed", "true")
  })

  it("calls onScopeChange when a scope pill is clicked", () => {
    const onScopeChange = vi.fn()
    render(
      <ParallelPassagesPanel
        {...baseProps({ onScopeChange, activeFileId: "file-1" })}
      />,
    )
    const scopeGroup = screen.getByRole("group", { name: /search scope/i })
    const fileBtn = within(scopeGroup).getByRole("button", { name: "File" })
    fireEvent.click(fileBtn)
    expect(onScopeChange).toHaveBeenCalledWith("file")
  })

  it("disables the File scope pill when there is no activeFileId", () => {
    render(<ParallelPassagesPanel {...baseProps({ activeFileId: undefined })} />)
    const scopeGroup = screen.getByRole("group", { name: /search scope/i })
    const fileBtn = within(scopeGroup).getByRole("button", { name: "File" })
    expect(fileBtn).toBeDisabled()
  })
})

// ── Retain-validations toggle ─────────────────────────────────────────────────

describe("ParallelPassagesPanel — retain validations", () => {
  it("defaults to retain=false", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const toggle = screen.getByRole("checkbox", { name: /retain my validations/i })
    expect(toggle).not.toBeChecked()
  })

  it("threads retainValidations=true through onReplaceAll payload when toggled on", async () => {
    const onReplaceAll = vi.fn()
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]

    render(
      <ParallelPassagesPanel {...baseProps({ results, onReplaceAll })} />,
    )

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    // Toggle retain validations ON.
    const retainToggle = screen.getByRole("checkbox", { name: /retain my validations/i })
    fireEvent.click(retainToggle)
    expect(retainToggle).toBeChecked()

    // Click the apply button.
    fireEvent.click(getApplyButton())

    await waitFor(() => {
      expect(onReplaceAll).toHaveBeenCalledTimes(1)
    })
    const payload = onReplaceAll.mock.calls[0][0] as ReplaceAllPayload
    expect(payload.retainValidations).toBe(true)
    expect(payload.findQuery).toBe("hello")
    expect(payload.replaceQuery).toBe("hi")
  })

  it("threads retainValidations=false through onReplaceAll payload when not toggled", async () => {
    const onReplaceAll = vi.fn()
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]

    render(
      <ParallelPassagesPanel {...baseProps({ results, onReplaceAll })} />,
    )

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
      target: { value: "hello" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    fireEvent.click(getApplyButton())

    await waitFor(() => expect(onReplaceAll).toHaveBeenCalledTimes(1))
    const payload = onReplaceAll.mock.calls[0][0] as ReplaceAllPayload
    expect(payload.retainValidations).toBe(false)
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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

    fireEvent.change(screen.getByRole("textbox", { name: /find in project/i }), {
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
