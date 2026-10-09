// Ghost text is a decoration only: whatever the forecast engine suggests must
// never reach the document (and so never a snapshot or commit) until the
// translator accepts it with Tab or →. These tests drive a real TipTap editor
// with the real engine answering in-thread.

import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { BiaEngine } from "@/lib/forecast/bia-engine"
import { createInThreadForecastClient, type ForecastClient } from "@/lib/forecast/forecast-client"
import {
  createGhostTextExtension,
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

async function editorWithGhost(
  content: string,
  client: ForecastClient | null = clientWith(CORPUS),
  dir: "ltr" | "rtl" = "ltr",
): Promise<Editor> {
  editor = new Editor({
    editorProps: { attributes: { dir } },
    extensions: [
      StarterKit,
      createGhostTextExtension({ getClient: () => client, getCellId: () => "active", debounceMs: 0, hasFocus: () => true }),
    ],
  })
  // Typed text (HTML parsing would trim the trailing space); the change
  // schedules a query with the caret at the end.
  editor.view.dispatch(editor.state.tr.insertText(content, 1))
  await vi.waitFor(() => expect(getGhostText(editor!.state)).not.toBeNull())
  return editor
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: name, cancelable: true, ...init })
}

describe("ghost-text plugin", () => {
  it("shows the suggestion as a widget without touching the document", async () => {
    const ed = await editorWithGhost("the lord is ")
    const ghost = getGhostText(ed.state)
    expect(ghost?.text).toBe("my shepherd")
    expect(ed.getText()).toBe("the lord is ")
    expect(ed.getHTML()).not.toContain("shepherd")
    expect(ed.state.doc.textContent).toBe("the lord is ")
    expect(ed.view.dom.querySelector("[data-testid='ghost-text']")?.textContent).toBe("my shepherd")
  })

  it("Esc dismisses without writing anything", async () => {
    const ed = await editorWithGhost("the lord is ")
    expect(handleGhostKeyDown(ed.view, key("Escape"))).toBe(true)
    expect(getGhostText(ed.state)).toBeNull()
    expect(ed.getText()).toBe("the lord is ")
    expect(ed.view.dom.querySelector("[data-testid='ghost-text']")).toBeNull()
  })

  it("Tab accepts the whole suggestion as ordinary text", async () => {
    const ed = await editorWithGhost("the lord is ")
    const updates = vi.fn()
    ed.on("update", updates)
    expect(handleGhostKeyDown(ed.view, key("Tab"))).toBe(true)
    expect(ed.getText()).toBe("the lord is my shepherd")
    // The accepted text is a normal doc change, so the editor's commit path runs.
    expect(updates).toHaveBeenCalled()
    expect(ed.state.selection.head).toBe(ed.state.doc.content.size - 1)
  })

  it("after Tab, the next ghost continues with the next word, not a completion of the last", async () => {
    const ed = await editorWithGhost("the lord is ")
    handleGhostKeyDown(ed.view, key("Tab"))
    await vi.waitFor(() => expect(getGhostText(ed.state)?.text).toBe(" leads me"))
    expect(ed.getText()).toBe("the lord is my shepherd")
  })

  it("→ at the end accepts one word and keeps the rest showing", async () => {
    const ed = await editorWithGhost("the lord is ")
    expect(handleGhostKeyDown(ed.view, key("ArrowRight"))).toBe(true)
    expect(ed.getText()).toBe("the lord is my")
    expect(getGhostText(ed.state)?.text).toBe(" shepherd")
  })

  it("in right-to-left text, ← (forward) accepts one word and → does not", async () => {
    const hebrew = clientWith(["בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם", "בָּרָא אֱלֹהִים אֵת הָאָרֶץ", "וַיֹּאמֶר אֱלֹהִים אֵת"])
    const ed = await editorWithGhost("בָּרָא ", hebrew, "rtl")
    expect(getGhostText(ed.state)?.text.startsWith("אֱלֹהִים")).toBe(true)
    expect(handleGhostKeyDown(ed.view, key("ArrowRight"))).toBe(false)
    expect(handleGhostKeyDown(ed.view, key("ArrowLeft"))).toBe(true)
    expect(ed.getText()).toBe("בָּרָא אֱלֹהִים")
  })

  it("accepts one Thai word at a time although the suggestion has no spaces", async () => {
    const thai = clientWith(["พระเจ้าทรงสร้างฟ้า", "พระเจ้าทรงสร้างแผ่นดิน", "พระเจ้าทรงสร้างฟ้า"])
    const ed = await editorWithGhost("พระเจ้าทรง", thai)
    expect(getGhostText(ed.state)?.text.startsWith("สร้าง")).toBe(true)
    handleGhostKeyDown(ed.view, key("ArrowRight"))
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
    expect(getGhostText(ed.state)?.text ?? "").not.toBe("my shepherd")
    expect(ed.getText()).toBe("the lord is g")
  })
})
