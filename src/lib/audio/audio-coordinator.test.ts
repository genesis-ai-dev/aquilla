import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type ActiveAudioController,
  clearActiveAudioIf, getActiveAudio, isInEditableContext, setActiveAudio,
  subscribeActiveAudio, togglePlayActive,
} from "./audio-coordinator"

function makeController(initial = false): ActiveAudioController & {
  playCount: number
  pauseCount: number
  setPlaying: (v: boolean) => void
} {
  let playing = initial
  let playCount = 0
  let pauseCount = 0
  return {
    isPlaying: () => playing,
    play: async () => { playCount += 1; playing = true },
    pause: () => { pauseCount += 1; playing = false },
    get playCount() { return playCount },
    get pauseCount() { return pauseCount },
    setPlaying: (v) => { playing = v },
  }
}

afterEach(() => {
  // Reset registry between tests so order doesn't bleed.
  const c = getActiveAudio()
  if (c) clearActiveAudioIf(c)
})

describe("audio-coordinator", () => {
  it("delegates togglePlayActive to the registered controller (live state)", async () => {
    const c = makeController(false)
    setActiveAudio(c)
    expect(togglePlayActive()).toBe(true)
    await Promise.resolve()
    expect(c.playCount).toBe(1)
    expect(c.isPlaying()).toBe(true)
    expect(togglePlayActive()).toBe(true)
    expect(c.pauseCount).toBe(1)
    expect(c.isPlaying()).toBe(false)
  })

  it("returns false from togglePlayActive when nothing is registered", () => {
    expect(togglePlayActive()).toBe(false)
  })

  it("clearActiveAudioIf only clears the matching controller", () => {
    const a = makeController()
    const b = makeController()
    setActiveAudio(a)
    clearActiveAudioIf(b)
    expect(getActiveAudio()).toBe(a)
    clearActiveAudioIf(a)
    expect(getActiveAudio()).toBeNull()
  })
})

describe("isInEditableContext", () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it("treats <input>, <textarea>, <select> as editable", () => {
    const inp = document.createElement("input")
    document.body.appendChild(inp)
    const ta = document.createElement("textarea")
    document.body.appendChild(ta)
    const sel = document.createElement("select")
    document.body.appendChild(sel)
    expect(isInEditableContext(inp)).toBe(true)
    expect(isInEditableContext(ta)).toBe(true)
    expect(isInEditableContext(sel)).toBe(true)
  })

  it("treats contentEditable elements (e.g. ProseMirror) as editable", () => {
    const div = document.createElement("div")
    div.setAttribute("contenteditable", "true")
    document.body.appendChild(div)
    expect(isInEditableContext(div)).toBe(true)
    const child = document.createElement("span")
    div.appendChild(child)
    expect(isInEditableContext(child)).toBe(true)
  })

  it("returns false for non-editable surfaces", () => {
    const btn = document.createElement("button")
    document.body.appendChild(btn)
    expect(isInEditableContext(btn)).toBe(false)
    expect(isInEditableContext(document.body)).toBe(false)
    expect(isInEditableContext(null)).toBe(false)
  })
})

describe("audio-coordinator setActiveAudio dedup", () => {
  it("doesn't notify when the same controller is re-registered", () => {
    const c = makeController()
    const listener = vi.fn()
    const sub = subscribeActiveAudio(listener)
    setActiveAudio(c)
    setActiveAudio(c)
    setActiveAudio(c)
    sub()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
