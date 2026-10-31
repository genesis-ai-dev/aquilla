/**
 * ParallelPassagesPanel — AQU-177 replace mode tests.
 *
 * WHY: The replace flow must show an inline diff preview before committing,
 * respect the scope toggle (file vs project), surface the HTML-spanning skip
 * count to the user, and always emit retainValidations=false (AQU-286:
 * "Retain my validations" checkbox was a server no-op and has been removed;
 * the honest copy "Replacing text clears validation" is shown instead).
 * These tests verify intent, not just wiring.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ParallelPassagesPanel, type ReplaceAllPayload } from "./ParallelPassagesPanel"
import { expectDisabledNote } from "@/test-utils/tooltip"
import { toast } from "@/components/ui/toast"
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
 * Get the "Replace all" / "Replace N" apply button, excluding the mode pill
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
    expect(screen.getByRole("heading", { level: 1, name: "Search and replace" })).toBeInTheDocument()
  })

  it("puts the replace field with the notes under it, and does not add a second diff list", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const field = screen.getByRole("textbox", { name: /^Replacement text$/ })
    const note = screen.getByText(/replacing text clears validation/i)
    expect(field.closest("[data-slot=input-group]")).toBeTruthy()
    expect(field.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/replace \(target cells only\)/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("list", { name: /cells to replace/i })).not.toBeInTheDocument()
  })
})

// ── Diff preview ──────────────────────────────────────────────────────────────

describe("ParallelPassagesPanel — match location", () => {
  const fileId = "019f19ed-27ae-7000-8000-000000000001"
  const cellA = "019f19eb-eb40-7000-8000-0000000000a1"
  const cellB = "019f19eb-eb40-7000-8000-0000000000b2"

  it("shows the verse above a scripture match and hides the raw ids", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          results: [
            makeResult({
              cellId: cellA,
              fileId,
              fileName: fileId,
              translated: "in the beginning",
              canonicalRef: "GEN 1:1",
              cellType: "verse",
              position: 1,
            }),
          ],
        })}
      />,
    )
    expect(screen.getByText("Genesis 1:1")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Include Genesis 1:1 in replace" })).toBeInTheDocument()
    expect(screen.queryByText(fileId)).not.toBeInTheDocument()
    expect(screen.queryByText(cellA)).not.toBeInTheDocument()
  })

  it("numbers two matches that share a verse, in file order", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          results: [
            makeResult({
              cellId: cellB,
              fileId,
              fileName: "Genesis",
              translated: "the second half",
              canonicalRef: "GEN 1:1",
              position: 2,
            }),
            makeResult({
              cellId: cellA,
              fileId,
              fileName: "Genesis",
              translated: "the first half",
              canonicalRef: "GEN 1:1",
              position: 1,
            }),
          ],
        })}
      />,
    )
    expect(screen.getByText("Genesis 1:1 (1 of 2)")).toBeInTheDocument()
    expect(screen.getByText("Genesis 1:1 (2 of 2)")).toBeInTheDocument()
  })

  it("shows the file and position for a cell that is not scripture", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          results: [
            makeResult({
              cellId: cellA,
              fileId,
              fileName: "Study notes",
              translated: "a note about light",
              position: 4,
            }),
          ],
        })}
      />,
    )
    expect(screen.getByText("Study notes · 4")).toBeInTheDocument()
    expect(screen.queryByText(cellA)).not.toBeInTheDocument()
  })
})

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

    const option = screen.getByRole("option", { name: /genesis/i })
    const struck = within(option).getByText("hello")
    expect(struck.tagName).toBe("MARK")
    expect(struck).toHaveClass("line-through")
    expect(struck).toHaveClass("text-inherit")
    expect(struck).toHaveClass("bg-red-200")
    const inserted = within(option).getByText("hi")
    expect(inserted.tagName).toBe("MARK")
    expect(inserted).not.toHaveClass("line-through")
    expect(inserted).toHaveClass("text-inherit")
    expect(inserted).toHaveClass("bg-emerald-200")
    expect(screen.queryByRole("list", { name: /cells to replace/i })).not.toBeInTheDocument()
  })

  it("selects every matched cell from the checkbox without an affected-count label", () => {
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

    expect(screen.queryByText(/cell affected/i)).not.toBeInTheDocument()
    expect(getApplyButton()).toHaveTextContent("Replace 1 cell")
    expect(screen.queryByRole("button", { name: /^select all$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /select none/i })).not.toBeInTheDocument()
    const selectAll = screen.getByRole("checkbox", { name: /select none/i })
    expect(selectAll).toHaveAttribute("aria-checked", "true")
    fireEvent.click(selectAll)
    expect(getApplyButton()).toBeDisabled()
  })

  it("names the selected cell count on the replace button", () => {
    const results = [
      makeResult({ cellId: "c1", translated: "foo bar" }),
      makeResult({ cellId: "c2", translated: "foo baz" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), { target: { value: "foo" } })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "qux" },
    })

    expect(getApplyButton()).toHaveTextContent("Replace 2 cells")
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
    expect(screen.queryByText(/cell affected/i)).not.toBeInTheDocument()
    expect(getApplyButton()).toHaveTextContent("Replace 1 cell")
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
    const option = screen.getByRole("option", { name: /genesis/i })
    expect(within(option).queryByText("xyz")).not.toBeInTheDocument()
    expect(within(option).getByText("hello world").closest("mark")).toBeNull()
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

  it("keeps the File tab labeled File while the footer names the open file", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          scope: "file",
          activeFileId: "file-1",
          activeFileName: "Berean Standard Bible (BSB)",
          results: [makeResult({ cellId: "c1", translated: "hello" })],
        })}
      />,
    )
    const scopeTabs = screen.getByRole("tablist", { name: /search scope/i })
    expect(within(scopeTabs).getByRole("tab", { name: "File" })).toBeInTheDocument()
    expect(within(scopeTabs).queryByRole("tab", { name: /berean/i })).not.toBeInTheDocument()
    expect(screen.getByText("File: Berean Standard Bible (BSB)")).toBeInTheDocument()
  })

  it("shows the file name in the footer before a search", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          scope: "file",
          activeFileId: "file-1",
          activeFileName: "Berean Standard Bible (BSB)",
        })}
      />,
    )
    expect(screen.getByText("File: Berean Standard Bible (BSB)")).toBeInTheDocument()
    expect(screen.queryByText(/^\d+ results?$/i)).not.toBeInTheDocument()
  })

  it("names the open file in the footer during parallel passages", () => {
    render(
      <ParallelPassagesPanel
        {...baseProps({
          mode: "passages",
          scope: "file",
          activeFileId: "file-1",
          activeFileName: "Berean Standard Bible (BSB)",
        })}
      />,
    )
    expect(screen.getByRole("heading", { level: 1, name: "Parallel passages" })).toBeInTheDocument()
    expect(screen.getByText("File: Berean Standard Bible (BSB)")).toBeInTheDocument()
  })

  it("disables the File scope tab when there is no activeFileId", () => {
    render(<ParallelPassagesPanel {...baseProps({ activeFileId: undefined })} />)
    const scopeTabs = screen.getByRole("tablist", { name: /search scope/i })
    const fileTab = within(scopeTabs).getByRole("tab", { name: "File" })
    expect(fileTab).toHaveAttribute("aria-disabled", "true")
  })
})

// ── AQU-286: "Retain my validations" removed — honest copy + always-false ────

describe("ParallelPassagesPanel — validation copy (AQU-286)", () => {
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

  // AQU-2260 (Sam, Oct 29): why it is greyed out opens on a click, never a hover.
  it("says why it is greyed out on a click when the files are read-only", async () => {
    render(<ParallelPassagesPanel {...baseProps({ isReadOnly: true })} />)
    await expectDisabledNote(getApplyButton(), "Replace requires contributor access on these files")
  })

  it("calls onReplaceAll with diffs including correct before/after values", async () => {
    const addToast = vi.spyOn(toast, "add").mockReturnValue("replace-toast")
    const onReplaceAll = vi.fn()
    const onSearch = vi.fn()
    const results = [
      makeResult({ cellId: "c1", fileId: "f1", translated: "hello world" }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results, onReplaceAll, onSearch })} />)

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
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Replaced 1 cell." }),
    )
    expect(onSearch).toHaveBeenCalledWith(
      "world",
      expect.objectContaining({ scope: "project", side: "target" }),
    )
    expect(
      onSearch.mock.invocationCallOrder.some(
        (order) => order > onReplaceAll.mock.invocationCallOrder[0],
      ),
    ).toBe(true)
    expect(screen.queryByText("Replaced 1 cell.")).not.toBeInTheDocument()
    addToast.mockRestore()
  })
})

// ── Accessible names distinct from placeholders (AQU-511 wave-3 finding 6) ────
//
// Both inputs previously reused the placeholder key as their aria-label, so
// the accessible name announced by a screen reader ended in "…" — a trailing
// ellipsis is legible visual affordance but nonsense read aloud as a field's
// name. These assert the accessible name has NO trailing ellipsis while the
// placeholder text (a separate key) keeps it, proving the two are no longer
// the same string.

describe("ParallelPassagesPanel — accessible names vs placeholders", () => {
  it("the replace input's accessible name has no trailing ellipsis, unlike its placeholder", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const input = screen.getByRole("textbox", { name: /^Replacement text$/ })
    expect(input.getAttribute("placeholder")).toBe("Replacement text…")
    expect(input.getAttribute("aria-label")).toBe("Replacement text")
  })

  it("the find input's accessible name has no trailing ellipsis in project-scope Replace mode", () => {
    render(<ParallelPassagesPanel {...baseProps({ mode: "replace", scope: "project" })} />)
    const input = getFindInput()
    expect(input.getAttribute("placeholder")).toBe("Find in project…")
    expect(input.getAttribute("aria-label")).toBe("Find in project")
  })
})

describe("ParallelPassagesPanel — source beside each replace match (AQU-1011)", () => {
  it("shows the source text on a target match without leaving the panel", () => {
    const results = [
      makeResult({
        cellId: "c1",
        fileId: "f1",
        translated: "teste de conteúdo",
        paired: "test of content",
      }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), { target: { value: "teste" } })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "prova" },
    })

    const option = screen.getByRole("option", { name: /genesis . target/i })
    const targetLabel = within(option).getByText("Target")
    const sourceLabel = within(option).getByText("Source")
    expect(targetLabel.compareDocumentPosition(within(option).getByText("teste")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sourceLabel.compareDocumentPosition(within(option).getByText("test of content")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(targetLabel.compareDocumentPosition(sourceLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const stack = targetLabel.parentElement?.parentElement
    expect(stack?.className).toMatch(/flex-col/)
    expect(stack?.className).not.toMatch(/grid-cols-2/)
    expect(stack?.className).not.toMatch(/\bps-/)
    expect(stack?.className).not.toMatch(/border-s/)
    expect(within(option).getByText("test of content")).toBeInTheDocument()
    const struck = within(option).getByText("teste")
    expect(struck).toHaveClass("line-through")
    expect(within(option).getByText("prova")).not.toHaveClass("line-through")
  })

  it("says when a match has no source text", () => {
    const results = [makeResult({ cellId: "c1", translated: "hello world" })]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), { target: { value: "hello" } })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "hi" },
    })

    expect(screen.getByText(/no source text for this cell/i)).toBeInTheDocument()
  })

  it("keeps the content side control in replace mode and still lists a source-only match", () => {
    const results = [
      makeResult({
        cellId: "c-source",
        translated: "",
        original: "content",
        snippet: "content",
        matchedFields: new Set(["original"]),
      }),
      makeResult({
        cellId: "c-target",
        translated: "teste",
        paired: "test",
      }),
    ]
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    const sideTabs = screen.getByRole("tablist", { name: /content side/i })
    expect(within(sideTabs).getByRole("tab", { name: "Both" })).toHaveAttribute("aria-disabled", "true")
    expect(within(sideTabs).getByRole("tab", { name: "Source" })).toHaveAttribute("aria-disabled", "true")
    expect(within(sideTabs).getByRole("tab", { name: "Target" })).toHaveAttribute("aria-selected", "true")
    const option = screen.getByRole("option", { name: /genesis \(1 of 2\).*source/i })
    expect(option.className).toContain("hover:bg-accent/40")
    expect(option.className).toContain("data-selected:bg-transparent")
    expect(option.className).not.toMatch(/data-selected:bg-accent/)
    expect(screen.getByText(/source match — not replaced/i)).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /genesis \(1 of 2\).*source/i })).toBeInTheDocument()
    expect(
      screen.getByText(/replace changes target text only/i),
    ).toBeInTheDocument()
  })

  it("searches target text when Replace is chosen after a source-side search", () => {
    const onSearch = vi.fn()
    render(<ParallelPassagesPanel {...baseProps({ mode: "search", onSearch })} />)

    fireEvent.change(screen.getByPlaceholderText(/search project/i), { target: { value: "content" } })
    fireEvent.click(screen.getByRole("tab", { name: "Source" }))

    expect(onSearch).toHaveBeenCalledWith(
      "content",
      expect.objectContaining({ side: "source" }),
    )

    fireEvent.click(screen.getByRole("tab", { name: "Replace" }))

    expect(onSearch).toHaveBeenLastCalledWith(
      "content",
      expect.objectContaining({ side: "target" }),
    )
  })

  it("keeps every result option in the list while the find term is typed", () => {
    const results = Array.from({ length: 8 }, (_, i) =>
      makeResult({
        cellId: `c${i}`,
        translated: i === 3 ? "content" : `row ${i}`,
        snippet: i === 3 ? "content" : `row ${i}`,
      }),
    )
    render(<ParallelPassagesPanel {...baseProps({ results })} />)

    fireEvent.change(getFindInput(), { target: { value: "content" } })

    expect(screen.getAllByRole("option")).toHaveLength(8)
    expect(screen.getAllByText("content").length).toBeGreaterThan(0)
  })

  it("centers the dialog in the viewport and scrolls the results inside it (AQU-2283)", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const list = screen.getByRole("listbox")
    expect(list).toHaveClass("overflow-y-auto")
    expect(list).toHaveClass("pe-4")
    expect(list).toHaveClass("flex-1")
    expect(list).toHaveClass("min-h-0")
    expect(list.parentElement).toHaveClass("-me-4")
    // The dialog, not the list, bounds the height: no fixed cap on the list.
    expect(list).toHaveClass("max-h-none")
    expect(list.className).not.toMatch(/max-h-\[46rem\]/)
    const dialog = screen.getByRole("dialog")
    // Base dialog placement: centered both ways, never anchored to the upper
    // quarter, so a short list and a full one sit in the same place.
    expect(dialog).toHaveClass("top-1/2")
    expect(dialog).toHaveClass("-translate-y-1/2")
    expect(dialog).toHaveClass("left-1/2")
    expect(dialog).toHaveClass("-translate-x-1/2")
    expect(dialog.className).not.toMatch(/top-\[25%\]/)
    expect(dialog.className).not.toMatch(/(^|\s)translate-y-0(\s|$)/)
    // Design cap of 46rem, clamped to the viewport so the footer and the
    // close button stay on screen at 700px-tall windows.
    expect(dialog.className).toMatch(/max-h-\[min\(46rem,85dvh\)\]/)
    expect(dialog.className).not.toMatch(/max-h-\[46rem\]/)
    expect(dialog).toHaveClass("overflow-hidden")
    expect(dialog).toHaveClass("flex")
    expect(dialog).toHaveClass("flex-col")
  })

  it("continues a dock query when the dialog opens", async () => {
    const onSearch = vi.fn()
    render(
      <ParallelPassagesPanel
        {...baseProps({ onSearch, initialQuery: "teste" })}
      />,
    )
    expect(getFindInput()).toHaveValue("teste")
    await waitFor(() =>
      expect(onSearch).toHaveBeenCalledWith(
        "teste",
        expect.objectContaining({ scope: "project" }),
      ),
    )
  })

  it("puts match case, whole word, and regexp on the find field, and preserve case on replace", () => {
    render(<ParallelPassagesPanel {...baseProps()} />)
    const find = getFindInput().closest("[data-slot=input-group]")
    expect(find).toBeTruthy()
    const end = find!.querySelector("[data-align=inline-end]")
    const start = find!.querySelector("[data-align=inline-start]")
    expect(end).toHaveClass("pe-1.5")
    expect(end).toHaveClass("ps-0!")
    expect(end).toHaveClass("cursor-default")
    fireEvent.click(end as HTMLElement)
    expect(getFindInput()).not.toHaveFocus()
    expect(start).toHaveClass("ps-2")
    expect(find).toHaveClass("has-[>[data-align=inline-end]]:[&>input]:pe-2!")
    expect(within(end as HTMLElement).getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "false")
    expect(within(end as HTMLElement).getByRole("button", { name: "Match whole word" })).toBeInTheDocument()
    expect(within(end as HTMLElement).getByRole("button", { name: "Use regular expression" })).toBeInTheDocument()
    const replace = screen.getByRole("textbox", { name: /^Replacement text$/ }).closest("[data-slot=input-group]")
    const replaceEnd = replace!.querySelector("[data-align=inline-end]")
    expect(replaceEnd).toHaveClass("pe-1.5")
    expect(replaceEnd).toHaveClass("ps-0!")
    expect(replaceEnd).toHaveClass("cursor-default")
    const replaceInput = screen.getByRole("textbox", { name: /^Replacement text$/ })
    fireEvent.click(replaceEnd as HTMLElement)
    expect(replaceInput).not.toHaveFocus()
    expect(replace).toHaveClass("has-[>[data-align=inline-end]]:[&>input]:pe-2!")
    expect(screen.getByRole("button", { name: "Preserve case" })).toHaveAttribute("aria-pressed", "false")
  })

  it("preserves the match's case in the replacement preview and sends match case to search", async () => {
    const onSearch = vi.fn()
    render(
      <ParallelPassagesPanel
        {...baseProps({
          onSearch,
          results: [makeResult({ translated: "Hello world", snippet: "Hello world" })],
        })}
      />,
    )
    fireEvent.change(getFindInput(), { target: { value: "hello" } })
    fireEvent.change(screen.getByRole("textbox", { name: /replacement text/i }), {
      target: { value: "world" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Preserve case" }))
    const option = screen.getByRole("option", { name: /genesis/i })
    expect(within(option).getByText("World")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Match case" }))
    expect(within(option).queryByText("World")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(onSearch).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({ caseSensitive: true }),
      ),
    )
  })
})
