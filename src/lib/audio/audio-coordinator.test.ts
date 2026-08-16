import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type ActiveAudioController,
  __resetAudioShortcutOverridesForTests,
  clearActiveAudioIf, getActiveAudio, isAudioShortcutOverridden,
  isInEditableContext, isTopAudioShortcutOwner, pushAudioShortcutOverride,
  setActiveAudio, subscribeActiveAudio, togglePlayActive,
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

// FORTIFY: the shortcut-owner stack has two tiers. The playback bar claims
// "base" at mount so the global last-clip handler stands down while the bar is
// visible — but the bar must never outrank the timeline or the recording
// modal, even though it MOUNTS after them in the media lens.
describe("audio shortcut owner tiers", () => {
  afterEach(() => __resetAudioShortcutOverridesForTests())

  it("a base claim counts as an override and is top while alone", () => {
    const bar = pushAudioShortcutOverride("base")
    expect(isAudioShortcutOverridden()).toBe(true)
    expect(isTopAudioShortcutOwner(bar.owner)).toBe(true)
    bar()
    expect(isAudioShortcutOverridden()).toBe(false)
  })

  it("a normal claim outranks a base claim even when the base claim came later", () => {
    const timeline = pushAudioShortcutOverride()
    const bar = pushAudioShortcutOverride("base") // bar mounts after the timeline
    expect(isTopAudioShortcutOwner(timeline.owner)).toBe(true)
    expect(isTopAudioShortcutOwner(bar.owner)).toBe(false)
    timeline()
    expect(isTopAudioShortcutOwner(bar.owner)).toBe(true)
  })

  it("normal claims keep mount order among themselves (modal above timeline)", () => {
    const bar = pushAudioShortcutOverride("base")
    const timeline = pushAudioShortcutOverride()
    const modal = pushAudioShortcutOverride()
    expect(isTopAudioShortcutOwner(modal.owner)).toBe(true)
    expect(isTopAudioShortcutOwner(timeline.owner)).toBe(false)
    modal()
    expect(isTopAudioShortcutOwner(timeline.owner)).toBe(true)
    timeline()
    expect(isTopAudioShortcutOwner(bar.owner)).toBe(true)
  })

  it("release is idempotent and order-independent", () => {
    const a = pushAudioShortcutOverride()
    const b = pushAudioShortcutOverride()
    a() // released out of order
    a() // double release is a no-op
    expect(isTopAudioShortcutOwner(b.owner)).toBe(true)
    b()
    expect(isAudioShortcutOverridden()).toBe(false)
  })
})
