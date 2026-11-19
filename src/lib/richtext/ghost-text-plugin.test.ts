// Ghost text is a decoration only: whatever the forecast engine suggests must
// never reach the document (and so never a snapshot or commit) until the
// translator accepts it with Tab or Ctrl/Cmd + →. These tests drive a real TipTap editor
// with the real engine answering in-thread.

import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { BiaEngine } from "@/lib/forecast/bia-engine"
import { createInThreadForecastClient, type ForecastClient } from "@/lib/forecast/forecast-client"
import {
  createGhostTextExtension,
  type GhostTextEvent,
  getGhostText,
  handleGhostKeyDown,
} from "./ghost-text-plugin"

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
  vi.useRealTimers()
})

function clientWith(texts: string[]): ForecastClient {
  const engine = new BiaEngine()
  engine.index.upsert(texts.map((text, i) => ({ id: `c${i}`, text, validated: true })))
  return createInThreadForecastClient(engine)
}

const CORPUS = ["the lord is my shepherd", "the lord is my light", "the lord is good", "my shepherd leads me"]

function newEditor(
  client: ForecastClient | null = clientWith(CORPUS),
  dir: "ltr" | "rtl" = "ltr",
  onEvent?: (event: GhostTextEvent) => void,
): Editor {
  const created = new Editor({
    editorProps: { attributes: { dir } },
    extensions: [
      StarterKit,
      createGhostTextExtension({ getClient: () => client, getCellId: () => "active", debounceMs: 0, hasFocus: () => true, onEvent }),
    ],
  })
  editor = created
  return created
}

async function editorWithGhost(
  content: string,
  client: ForecastClient | null = clientWith(CORPUS),
  dir: "ltr" | "rtl" = "ltr",
  onEvent?: (event: GhostTextEvent) => void,
): Promise<Editor> {
  const created = newEditor(client, dir, onEvent)
  // Typed text (HTML parsing would trim the trailing space); the change
  // schedules a query with the caret at the end.
  created.view.dispatch(created.state.tr.insertText(content, 1))
  await vi.waitFor(() => expect(getGhostText(created.state)).not.toBeNull())
  return created
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name, cancelable: true, ...init })
}

describe("ghost-text plugin", () => {
  it("shows the suggestion as a widget without touching the document", async () => {
    const ed = await editorWithGhost("the lord is ")
    const ghost = getGhostText(ed.state)
    // One word at a time, never the engine's two-word extension.
    expect(ghost?.text).toBe("my")
    expect(ed.getText()).toBe("the lord is ")
    expect(ed.getHTML()).not.toContain("my")
    expect(ed.state.doc.textContent).toBe("the lord is ")
    expect(ed.view.dom.querySelector("[data-testid='ghost-text']")?.textContent).toBe("my")
  })

  it("Esc dismisses without writing anything", async () => {
    const ed = await editorWithGhost("the lord is ")
    expect(handleGhostKeyDown(ed.view, key("Escape"))).toBe(true)
    expect(getGhostText(ed.state)).toBeNull()
    expect(ed.getText()).toBe("the lord is ")
    expect(ed.view.dom.querySelector("[data-testid='ghost-text']")).toBeNull()
  })

  it("Tab accepts the suggested word as ordinary text", async () => {
    const ed = await editorWithGhost("the lord is ")
    const updates = vi.fn()
    ed.on("update", updates)
    expect(handleGhostKeyDown(ed.view, key("Tab"))).toBe(true)
    expect(ed.getText()).toBe("the lord is my")
    // The accepted text is a normal doc change, so the editor's commit path runs.
    expect(updates).toHaveBeenCalled()
    expect(ed.state.selection.head).toBe(ed.state.doc.content.size - 1)
  })

  it("after Tab, the next ghost continues with the next word, not a completion of the last", async () => {
    const ed = await editorWithGhost("the lord is ")
    handleGhostKeyDown(ed.view, key("Tab"))
    await vi.waitFor(() => expect(getGhostText(ed.state)?.text).toBe(" shepherd"))
    expect(ed.getText()).toBe("the lord is my")
  })

  it("a plain → only moves the caret; Ctrl/Cmd + → accepts the word", async () => {
    const ed = await editorWithGhost("the lord is ")
    expect(handleGhostKeyDown(ed.view, key("ArrowRight"))).toBe(false)
    expect(ed.getText()).toBe("the lord is ")
    expect(handleGhostKeyDown(ed.view, key("ArrowRight", { ctrlKey: true }))).toBe(true)
    expect(ed.getText()).toBe("the lord is my")
    await vi.waitFor(() => expect(getGhostText(ed.state)?.text).toBe(" shepherd"))
    expect(handleGhostKeyDown(ed.view, key("ArrowRight", { metaKey: true }))).toBe(true)
    expect(ed.getText()).toBe("the lord is my shepherd")
  })

  it("in right-to-left text, Ctrl + ← (forward) accepts one word and Ctrl + → does not", async () => {
    const hebrew = clientWith(["בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם", "בָּרָא אֱלֹהִים אֵת הָאָרֶץ", "וַיֹּאמֶר אֱלֹהִים אֵת"])
    const ed = await editorWithGhost("בָּרָא ", hebrew, "rtl")
    expect(getGhostText(ed.state)?.text.startsWith("אֱלֹהִים")).toBe(true)
    expect(handleGhostKeyDown(ed.view, key("ArrowRight", { ctrlKey: true }))).toBe(false)
    expect(handleGhostKeyDown(ed.view, key("ArrowLeft", { ctrlKey: true }))).toBe(true)
    expect(ed.getText()).toBe("בָּרָא אֱלֹהִים")
  })

  it("accepts one Thai word at a time although the suggestion has no spaces", async () => {
    const thai = clientWith(["พระเจ้าทรงสร้างฟ้า", "พระเจ้าทรงสร้างแผ่นดิน", "พระเจ้าทรงสร้างฟ้า"])
    const ed = await editorWithGhost("พระเจ้าทรง", thai)
    expect(getGhostText(ed.state)?.text).toBe("สร้าง")
    handleGhostKeyDown(ed.view, key("Tab"))
    expect(ed.getText()).toBe("พระเจ้าทรงสร้าง")
  })

  it("leaves Tab to cell navigation when there is no ghost", async () => {
    editor = new Editor({
      content: "<p>zzz</p>",
      extensions: [StarterKit, createGhostTextExtension({ getClient: () => null, getCellId: () => "x", hasFocus: () => true })],
    })
    expect(handleGhostKeyDown(editor.view, key("Tab"))).toBe(false)
    expect(handleGhostKeyDown(editor.view, key("Tab", { shiftKey: true }))).toBe(false)
  })

  it("completes a partial word with only its remainder", async () => {
    const ed = await editorWithGhost("the lord is my sh")
    expect(getGhostText(ed.state)?.text.startsWith("epherd")).toBe(true)
    expect(ed.getText()).toBe("the lord is my sh")
  })

  it("drops a typed character's stale suggestion", async () => {
    const ed = await editorWithGhost("the lord is ")
    ed.commands.insertContent("g")
    expect(getGhostText(ed.state)?.text ?? "").not.toBe("my")
    expect(ed.getText()).toBe("the lord is g")
  })

  it("asks nothing on focus or a caret move, only after typing", async () => {
    const client = clientWith(CORPUS)
    const suggest = vi.spyOn(client, "suggest")
    const ed = newEditor(client)
    ed.commands.setContent("<p>the lord is my</p>")
    suggest.mockClear()
    ed.view.dom.dispatchEvent(new FocusEvent("focus"))
    ed.commands.setTextSelection(3)
    await new Promise((r) => setTimeout(r, 20))
    expect(suggest).not.toHaveBeenCalled()
    expect(getGhostText(ed.state)).toBeNull()
  })

  it("shows nothing with text after the caret", async () => {
    const ed = newEditor()
    ed.commands.setContent("<p>the lord is  good</p>")
    // Caret after "the lord is " with " good" still to its right.
    ed.view.dispatch(ed.state.tr.insertText("x", 13).delete(13, 14))
    await new Promise((r) => setTimeout(r, 20))
    expect(getGhostText(ed.state)).toBeNull()
  })

  it("never shows the most-frequent-word fallback", async () => {
    // No context in the corpus predicts after "zz", so only the frequency
    // fallback could answer "s" → "shepherd".
    const ed = newEditor()
    ed.view.dispatch(ed.state.tr.insertText("zz s", 1))
    await new Promise((r) => setTimeout(r, 20))
    expect(getGhostText(ed.state)).toBeNull()
  })

  it("reports shown and accepted, with no text", async () => {
    const events: GhostTextEvent[] = []
    const ed = await editorWithGhost("the lord is ", undefined, "ltr", (e) => events.push(e))
    handleGhostKeyDown(ed.view, key("Tab"))
    expect(events[0]).toMatchObject({ type: "shown" })
    expect(events[1]).toMatchObject({ type: "accepted", how: "tab" })
    expect(JSON.stringify(events)).not.toContain("my")
  })
})
