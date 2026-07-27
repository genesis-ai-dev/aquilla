import { describe, expect, it } from "vitest"
import { spacebarShouldToggle } from "./playback-keys"

// AQU-660: the Audio-lens playback bar binds Space to play/pause, but must not
// steal the key while the user is typing (TipTap editor / inputs) or has a
// control focused (buttons, sliders) where Space already means "activate".
const evt = (over: Partial<Parameters<typeof spacebarShouldToggle>[0]>) =>
  ({ code: "Space", target: document.body, ...over }) as Parameters<typeof spacebarShouldToggle>[0]

describe("spacebarShouldToggle", () => {
  it("toggles on a bare Space with nothing interactive focused", () => {
    expect(spacebarShouldToggle(evt({}))).toBe(true)
    expect(spacebarShouldToggle(evt({ code: undefined, key: " " }))).toBe(true)
  })

  it("ignores non-Space keys", () => {
    expect(spacebarShouldToggle(evt({ code: "KeyK", key: "k" }))).toBe(false)
    expect(spacebarShouldToggle(evt({ code: "Enter", key: "Enter" }))).toBe(false)
  })

  it("ignores Space with a modifier (leaves browser/OS shortcuts alone)", () => {
    expect(spacebarShouldToggle(evt({ ctrlKey: true }))).toBe(false)
    expect(spacebarShouldToggle(evt({ metaKey: true }))).toBe(false)
    expect(spacebarShouldToggle(evt({ altKey: true }))).toBe(false)
    expect(spacebarShouldToggle(evt({ shiftKey: true }))).toBe(false)
  })

  it("does not hijack Space while typing in a field", () => {
    const input = document.createElement("input")
    const textarea = document.createElement("textarea")
    expect(spacebarShouldToggle(evt({ target: input }))).toBe(false)
    expect(spacebarShouldToggle(evt({ target: textarea }))).toBe(false)
  })

  it("does not hijack Space inside a contenteditable (the editor)", () => {
    const editable = document.createElement("div")
    editable.setAttribute("contenteditable", "true")
    // happy-dom reflects contenteditable="true" into isContentEditable.
    expect(spacebarShouldToggle(evt({ target: editable }))).toBe(false)
  })

  it("does not double-fire when a button or slider is focused", () => {
    const button = document.createElement("button")
    const slider = document.createElement("div")
    slider.setAttribute("role", "slider")
    expect(spacebarShouldToggle(evt({ target: button }))).toBe(false)
    expect(spacebarShouldToggle(evt({ target: slider }))).toBe(false)
  })
})
