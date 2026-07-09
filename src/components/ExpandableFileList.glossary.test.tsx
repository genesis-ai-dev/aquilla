import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ExpandableFileList } from "./ExpandableFileList"
import { EditorScrollProvider } from "@/context/EditorScrollContext"

const baseProps = {
  projectId: "p1",
  files: [],
  activeFileId: null,
  fileProgress: new Map(),
  suggestionFileIds: new Set<string>(),
  validationCount: 0,
  getTokenForFile: async () => null,
  onSelectFile: vi.fn(),
  onRename: vi.fn(),
  onMove: vi.fn(),
}

describe("ExpandableFileList glossary pseudo-file", () => {
  it("does not render a Glossary entry when onOpenGlossary is omitted", () => {
    render(
      <EditorScrollProvider>
        <ExpandableFileList {...baseProps} />
      </EditorScrollProvider>,
    )
    expect(screen.queryByRole("button", { name: /glossary/i })).toBeNull()
  })

  it("renders a Glossary entry and fires onOpenGlossary on click", () => {
    const onOpenGlossary = vi.fn()
    render(
      <EditorScrollProvider>
        <ExpandableFileList {...baseProps} onOpenGlossary={onOpenGlossary} />
      </EditorScrollProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: /glossary/i }))
    expect(onOpenGlossary).toHaveBeenCalledTimes(1)
  })
})
