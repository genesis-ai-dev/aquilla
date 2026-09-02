import { afterEach, describe, expect, it, vi } from "vitest"
import {
  hasKokoroPreview,
  kokoroPreviewUrl,
  stopKokoroPreview,
  subscribeKokoroPreview,
  toggleKokoroPreview,
} from "./kokoro-preview"

class FakeAudio {
  src: string
  paused = true
  play = vi.fn(() => {
    this.paused = false
    return Promise.resolve()
  })
  pause = vi.fn(() => {
    this.paused = true
  })
  load = vi.fn()
  removeAttribute = vi.fn()
  addEventListener = vi.fn()
  constructor(src?: string) {
    this.src = src ?? ""
  }
}

describe("kokoro preview urls", () => {
  it("points bundled ids at the static mp3", () => {
    expect(kokoroPreviewUrl("af_heart")).toBe("/kokoro-previews/af_heart.mp3")
    expect(hasKokoroPreview("af_heart")).toBe(true)
    expect(hasKokoroPreview("ef_dora")).toBe(false)
  })
})

describe("toggleKokoroPreview", () => {
  afterEach(() => {
    stopKokoroPreview()
    vi.unstubAllGlobals()
  })

  it("plays one sample at a time and toggling the same id stops it", () => {
    vi.stubGlobal("Audio", FakeAudio)
    const seen: Array<string | null> = []
    const unsub = subscribeKokoroPreview((id) => {
      seen.push(id)
    })

    toggleKokoroPreview("af_bella")
    expect(seen.at(-1)).toBe("af_bella")
    toggleKokoroPreview("am_adam")
    expect(seen.at(-1)).toBe("am_adam")
    toggleKokoroPreview("am_adam")
    expect(seen.at(-1)).toBeNull()

    unsub()
  })
})
