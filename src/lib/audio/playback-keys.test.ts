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

  it("refuses a role=button DIV (dropzones, voice cards)", () => {
    const divButton = document.createElement("div")
    divButton.setAttribute("role", "button")
    expect(spacebarShouldToggle(evt({ target: divButton }))).toBe(false)
  })

  it("toggles on a role=button DIV that opts in as transport surface (timeline card)", () => {
    // Click-a-verse-then-Space: the card is role="button" tabIndex=0, so the
    // click FOCUSES it — Space must still play, not go dead.
    const card = document.createElement("div")
    card.setAttribute("role", "button")
    card.setAttribute("data-spacebar-transport", "")
    expect(spacebarShouldToggle(evt({ target: card }))).toBe(true)
  })

  it("still refuses a real <button> inside an opted-in card (mute, record)", () => {
    const card = document.createElement("div")
    card.setAttribute("role", "button")
    card.setAttribute("data-spacebar-transport", "")
    const mute = document.createElement("button")
    card.appendChild(mute)
    expect(spacebarShouldToggle(evt({ target: mute }))).toBe(false)
  })

  it("toggles on a real <button> that opts in as transport surface (dub chip)", () => {
    // Click-a-chip-then-Space: the chip is a real <button>, so the click
    // focuses it — Space must still play, not go dead.
    const chip = document.createElement("button")
    chip.setAttribute("data-spacebar-transport", "")
    expect(spacebarShouldToggle(evt({ target: chip }))).toBe(true)
  })

  it("a control nested INSIDE an opted-in chip keeps its native Space (corner record)", () => {
    // OWN-attribute rule: the chip's corner record button must not inherit
    // the transport opt-in from its parent.
    const chip = document.createElement("button")
    chip.setAttribute("data-spacebar-transport", "")
    const record = document.createElement("span")
    record.setAttribute("role", "button")
    record.tabIndex = 0
    chip.appendChild(record)
    expect(spacebarShouldToggle(evt({ target: record }))).toBe(false)
  })
})
