import { createHash } from "node:crypto"
import type { Editor } from "@tiptap/core"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import type { TranslatedEditorCommit } from "@/components/TranslatedEditor"
import type { TargetPresenceSelection } from "@/lib/sync/presence-store"
import { AgentDocumentContext, type AgentDocumentContextProps } from "./AgentDocumentContext"

function workspace(): AgentDocumentContextProps["workspace"] {
  return {
    fileName: "Mark.md",
    sourceLanguage: "en",
    targetLanguage: "it",
    editable: true,
    onCommitTarget: vi.fn<(cellId: string, snapshot: TranslatedEditorCommit) => void>(),
    onClaimCell: vi.fn(),
    onReleaseCell: vi.fn(),
    onTargetPresenceSelection: vi.fn<(cellId: string, selection: TargetPresenceSelection | null) => void>(),
    onOpenComments: vi.fn(),
    openCommentCounts: new Map([["c1", 2]]),
    onOpenHistory: vi.fn(),
    onDraftTarget: vi.fn().mockResolvedValue(true),
    isCompletionConfigured: true,
    isCompletionAvailable: true,
    currentUsername: "alice",
    canValidate: true,
    onValidationChange: vi.fn().mockResolvedValue(true),
    cells: [
      {
        cellId: "c1", fileId: "f1", ref: "MRK 1:1", source: "The beginning",
        target: "L'inizio", targetHtml: "<p>L'<em>inizio</em></p>", status: "unvalidated",
        validationStatus: "none", activeValidators: [], validationHistory: [], canValidate: true,
        healthRibbonPoint: { id: "c1", stage: "automatic", rawScore: 72, smoothedScore: 72, evidenceWeight: 1 },
      },
      {
        cellId: "c2", fileId: "f1", ref: "MRK 1:2", source: "A second sentence",
        target: "", status: "empty", validationStatus: "empty", canValidate: true,
      },
    ],
  }
}

type EditorSurface = HTMLElement & { editor: Editor }

async function activateEditor(ref = "MRK 1:1") {
  const row = screen.getByRole("article", { name: ref })
  fireEvent.click(within(row).getByRole("textbox"))
  await waitFor(() => expect(row.querySelector(".ProseMirror")).toBeInTheDocument())
  return row.querySelector(".ProseMirror") as EditorSurface
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AgentDocumentContext uses the live editor contract", () => {
  it("mounts only the active editor, preserving rich-text snapshots, direction and focus/presence callbacks", async () => {
    const data = workspace()
    data.cells[0].targetTextDirection = "rtl"
    data.cells[0].targetDirectionMode = "rtl"
    const view = render(<AgentDocumentContext workspace={data} />)
    expect(view.container.querySelectorAll(".ProseMirror")).toHaveLength(0)
    const surface = await activateEditor()
    expect(surface).toHaveFocus()
    expect(surface.querySelector("em")).toHaveTextContent("inizio")
    expect(surface).toHaveAttribute("dir", "rtl")
    expect(surface).toHaveAttribute("lang", "it")
    act(() => {
      fireEvent.focus(surface)
      surface.editor.commands.setContent("<p>Una <strong>traduzione</strong> nuova</p>")
      surface.editor.commands.setTextSelection(3)
      fireEvent.blur(surface)
    })
    await waitFor(() => expect(data.onCommitTarget).toHaveBeenCalledWith("c1", {
      value: "Una traduzione nuova",
      valueHtml: "<p>Una <strong>traduzione</strong> nuova</p>",
    }))
    expect(data.onClaimCell).toHaveBeenCalledWith("c1")
    expect(data.onReleaseCell).toHaveBeenCalledWith("c1")
    expect(data.onTargetPresenceSelection).toHaveBeenCalledWith("c1", null)
    expect(vi.mocked(data.onTargetPresenceSelection!).mock.calls.some(([id, selection]) => id === "c1" && selection !== null)).toBe(true)
    await activateEditor("MRK 1:2")
    expect(view.container.querySelectorAll(".ProseMirror")).toHaveLength(1)
    expect(within(screen.getByRole("article", { name: "MRK 1:1" })).getByRole("textbox")).toHaveAttribute("data-editor-cell-surface", "target-read")
  })

  it("flushes a pending full commit on document unmount", async () => {
    const data = workspace()
    const view = render(<AgentDocumentContext workspace={data} />)
    const surface = await activateEditor()
    act(() => surface.editor.commands.setContent("<p>Saved <em>before leaving</em></p>"))
    view.unmount()
    await waitFor(() => expect(data.onCommitTarget).toHaveBeenCalledWith("c1", {
      value: "Saved before leaving", valueHtml: "<p>Saved <em>before leaving</em></p>",
    }))
    expect(data.onReleaseCell).toHaveBeenCalledExactlyOnceWith("c1")
  })

  it("returns focus to the paired row on Escape and releases the active lock once", async () => {
    const data = workspace()
    render(<AgentDocumentContext workspace={data} />)
    const surface = await activateEditor()
    fireEvent.keyDown(surface, { key: "Escape" })
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    expect(row).toHaveFocus()
    expect(row.querySelector(".ProseMirror")).not.toBeInTheDocument()
    expect(data.onReleaseCell).toHaveBeenCalledExactlyOnceWith("c1")
  })

  it.each(["synchronous", "asynchronous"] as const)("surfaces %s commit failures beside the correct pair", async (mode) => {
    const data = workspace()
    data.onCommitTarget = mode === "synchronous"
      ? vi.fn(() => { throw new Error("Unable to save this cell") })
      : vi.fn().mockRejectedValue(new Error("Unable to save this cell"))
    render(<AgentDocumentContext workspace={data} />)
    const surface = await activateEditor()
    act(() => {
      surface.editor.commands.setContent("<p>Changed</p>")
      fireEvent.blur(surface)
    })
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    await waitFor(() => expect(within(row).getByRole("alert")).toHaveTextContent("Unable to save this cell"))
    expect(within(screen.getByRole("article", { name: "MRK 1:2" })).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("honors read-only and remote-lock guards without disabling comments/history", async () => {
    const data = workspace()
    const view = render(<AgentDocumentContext workspace={{ ...data, cellLockHolders: new Map([["c1", "Bob"]]) }} />)
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    const target = within(row).getByRole("textbox")
    expect(target).toHaveAttribute("aria-readonly", "true")
    fireEvent.click(target)
    fireEvent.keyDown(target, { key: "Enter" })
    expect(row.querySelector(".ProseMirror")).not.toBeInTheDocument()
    expect(within(row).getByText("Bob is editing")).toBeInTheDocument()
    expect(within(row).getByRole("button", { name: "Read-only (imported from git)" })).toBeDisabled()
    fireEvent.click(within(row).getByRole("button", { name: "2 open comments" }))
    fireEvent.click(within(row).getByRole("button", { name: "Edit history" }))
    expect(data.onOpenComments).toHaveBeenCalledWith("c1")
    expect(data.onOpenHistory).toHaveBeenCalledWith("c1")
    view.rerender(<AgentDocumentContext workspace={{ ...data, editable: false }} />)
    expect(within(row).getByRole("textbox")).toHaveAttribute("aria-readonly", "true")
    view.rerender(<AgentDocumentContext workspace={{ ...data, onCommitTarget: undefined }} />)
    fireEvent.click(within(row).getByRole("textbox"))
    expect(row.querySelector(".ProseMirror")).not.toBeInTheDocument()
    view.rerender(<AgentDocumentContext workspace={data} />)
    const surface = await activateEditor()
    view.rerender(<AgentDocumentContext workspace={{ ...data, cellLockHolders: new Map([["c1", "Bob"]]) }} />)
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"))
    expect(data.onCommitTarget).not.toHaveBeenCalled()
  })

  it("uses validation eligibility and optimistic toggle controls in the header instead of a text gutter", async () => {
    const data = workspace()
    const view = render(<AgentDocumentContext workspace={data} />)
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    const button = within(row).getByRole("button", { name: "Not validated — MRK 1:1. Click to validate." })
    expect(button).toHaveClass("h-6", "w-6")
    expect(button.closest('[data-testid="target-header-lane"]')).not.toBeNull()
    expect(within(row).getByTestId("health-ribbon")).toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(data.onValidationChange).toHaveBeenCalledWith("c1", true))
    expect(within(row).getByRole("button", { name: "Validated — MRK 1:1. Click to remove your validation." })).toHaveAttribute("aria-pressed", "true")
    expect(within(screen.getByRole("article", { name: "MRK 1:2" })).queryByRole("button", { name: /Click to validate/ })).not.toBeInTheDocument()
    view.rerender(<AgentDocumentContext workspace={{ ...data, cells: data.cells.map((cell) => ({ ...cell, canValidate: false })) }} />)
    expect(within(row).getByRole("button", { name: "Validated — MRK 1:1. Click to remove your validation." })).toBeDisabled()
  })

  it("keeps draft/regenerate/setup actions and blocks anonymous, unavailable and busy generation", () => {
    const data = workspace()
    const setup = vi.fn()
    const view = render(<AgentDocumentContext workspace={data} />)
    const empty = screen.getByRole("article", { name: "MRK 1:2" })
    fireEvent.click(within(empty).getByRole("button", { name: "Translate with AI" }))
    expect(data.onDraftTarget).toHaveBeenCalledWith("c2")
    fireEvent.click(screen.getByRole("button", { name: "Regenerate — another AI variation" }))
    expect(data.onDraftTarget).toHaveBeenCalledWith("c1", { regenerate: true })
    view.rerender(<AgentDocumentContext workspace={{ ...data, isCompletionConfigured: false, onAiSetupNeeded: setup }} />)
    fireEvent.click(within(empty).getByRole("button", { name: "Set up AI to enable" }))
    expect(setup).toHaveBeenCalledOnce()
    view.rerender(<AgentDocumentContext workspace={{ ...data, isAnonymous: true }} />)
    expect(within(empty).getByRole("button", { name: "Sign in for AI translations" })).toBeDisabled()
    view.rerender(<AgentDocumentContext workspace={{ ...data, isCompletionAvailable: false }} />)
    expect(within(empty).getByRole("button", { name: "AI service unavailable — try again shortly" })).toBeDisabled()
    view.rerender(<AgentDocumentContext workspace={{ ...data, completing: new Map([["c2", "generating"]]) }} />)
    expect(within(empty).getByRole("button", { name: "Generating…" })).toBeDisabled()
    expect(data.onDraftTarget).toHaveBeenCalledTimes(2)
  })

  it("still requires confirmation before AI replaces a validated target", async () => {
    const data = workspace()
    data.cells[0].status = "validated"
    render(<AgentDocumentContext workspace={data} />)
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    fireEvent.click(within(row).getByRole("button", { name: "Translate with AI" }))
    const dialog = await screen.findByRole("dialog", { name: "Replace validated translation?" })
    expect(data.onDraftTarget).not.toHaveBeenCalled()
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace" }))
    expect(data.onDraftTarget).toHaveBeenCalledWith("c1")
  })

  it("passes protected IDML through the real renderer/editor and commits a valid full snapshot", async () => {
    const sourceHtml = '<p data-idml-version="2">'
      + '<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Source</span>'
      + '<span data-idml-token="0" data-idml-token-kind="tab" data-idml-protected="token" contenteditable="false"></span>'
      + '<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">Second</span></p>'
    const metadata: IdmlFormatMetadataV2 = {
      version: 2, slotCount: 2, editableSlotIndexes: [0, 1], protectedTokenCount: 1,
      anchorSequenceHash: createHash("sha256").update([
        "slot:0:editable:CharacterStyle/Body", "token:0:tab", "slot:1:editable:CharacterStyle/Bold",
      ].join("\u0000")).digest("hex"),
    }
    const data = workspace()
    data.cells = [{
      ...data.cells[0], sourceHtml, source: "Source\tSecond", target: "",
      targetHtml: sourceHtml.replace(">Source</span>", "></span>").replace(">Second</span>", "></span>"),
      idmlConfiguration: { kind: "ready", context: { sourceHtml, metadata } },
    }]
    render(<AgentDocumentContext workspace={data} />)
    const row = screen.getByRole("article", { name: "MRK 1:1" })
    expect(within(row).getByRole("textbox").querySelectorAll("[data-idml-slot]")).toHaveLength(2)
    const surface = await activateEditor()
    act(() => {
      fireEvent.focus(surface)
      fireEvent.click(surface)
      for (const key of "Prima") fireEvent.keyDown(surface, { key })
      fireEvent.click(surface.querySelector('[data-idml-slot="1"]')!)
      for (const key of "Seconda") fireEvent.keyDown(surface, { key })
      fireEvent.blur(surface)
    })
    await waitFor(() => expect(data.onCommitTarget).toHaveBeenCalledWith("c1", expect.objectContaining({ value: "Prima\tSeconda" })))
    const snapshot = vi.mocked(data.onCommitTarget!).mock.calls.at(-1)![1]
    expect(validateIdmlTranslation(sourceHtml, snapshot.valueHtml, metadata).valid).toBe(true)
    expect(snapshot.valueHtml).toContain('data-idml-token="0"')
  })
})
