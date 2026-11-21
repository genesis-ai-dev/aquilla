import { describe, expect, it } from "vitest"

import { claimsCellSelectAll, isCellSelectAllKey } from "./select-all-key"

function press(target: Node, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe("cell select-all key", () => {
  it("matches Command-A and Control-A only", () => {
    const cases: { name: string; event: KeyboardEventInit & { key: string }; want: boolean }[] = [
      { name: "command", event: { key: "a", metaKey: true }, want: true },
      { name: "control", event: { key: "a", ctrlKey: true }, want: true },
      { name: "plain a", event: { key: "a" }, want: false },
      { name: "shift", event: { key: "a", metaKey: true, shiftKey: true }, want: false },
    ]
    for (const entry of cases) {
      expect(isCellSelectAllKey(new KeyboardEvent("keydown", entry.event)), entry.name).toBe(entry.want)
    }
  })

  it("checks the cells in the open text pane, and leaves a text area alone", () => {
    const host = document.createElement("div")
    host.dataset.mediaPanel = "text"
    const root = document.createElement("div")
    const row = document.createElement("div")
    row.tabIndex = 0
    const cellEditor = document.createElement("div")
    cellEditor.setAttribute("contenteditable", "true")
    row.append(cellEditor)
    root.append(row)
    host.append(root)
    document.body.append(host)
    const field = document.createElement("textarea")
    document.body.append(field)

    row.focus()
    expect(claimsCellSelectAll(root, press(row, { metaKey: true }))).toBe(true)
    ;(document.body as HTMLElement).focus()
    expect(claimsCellSelectAll(root, press(document.body, { metaKey: true }))).toBe(true)
    cellEditor.focus()
    expect(claimsCellSelectAll(root, press(cellEditor, { metaKey: true }))).toBe(false)
    field.focus()
    expect(claimsCellSelectAll(root, press(field, { ctrlKey: true }))).toBe(false)

    host.inert = true
    row.focus()
    expect(claimsCellSelectAll(root, press(row, { metaKey: true }))).toBe(false)

    host.remove()
    field.remove()
  })
})