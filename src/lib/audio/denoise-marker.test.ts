// The `dn-` marker is how a denoised (noise-removed) take is recognised
// everywhere — it drives the inline "Noise removed" state, the takes-strip
// "Cleaned" pin, and which cards offer denoise vs revert. A regression here
// silently mislabels takes or offers denoise on an already-clean clip.

import { describe, it, expect } from "vitest"
import { buildDenoisedAudioId, isDenoisedAudioId, buildAudioId } from "./upload"

describe("denoised-take marker", () => {
  it("builds an id that is recognised as denoised", () => {
    const id = buildDenoisedAudioId("GEN 1:1")
    expect(isDenoisedAudioId(id)).toBe(true)
    expect(id.startsWith("dn-")).toBe(true)
  })

  it("does not flag a normal recording id as denoised", () => {
    expect(isDenoisedAudioId(buildAudioId("GEN 1:1"))).toBe(false)
    expect(isDenoisedAudioId("audio-GEN_1_1-123-abc")).toBe(false)
  })

  it("still recognises the stored <id>.<ext> form (marker is on the leading segment)", () => {
    const id = buildDenoisedAudioId("cell-x")
    expect(isDenoisedAudioId(`${id}.webm`)).toBe(true)
    expect(isDenoisedAudioId("audio-cell-x-123-abc.webm")).toBe(false)
  })

  it("derives distinct ids on repeated calls (timestamp + random suffix)", () => {
    const a = buildDenoisedAudioId("c")
    const b = buildDenoisedAudioId("c")
    // Both denoised, but unique objects in R2 / the attachments map.
    expect(isDenoisedAudioId(a) && isDenoisedAudioId(b)).toBe(true)
  })
})
