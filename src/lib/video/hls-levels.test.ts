import { describe, expect, it } from "vitest"

import { capIndexForHeight, isHlsSource, MAX_LEVEL_HEIGHT, type LevelLike } from "./hls-levels"

/**
 * Episode 101's real master playlist, as a player presents it: the ten
 * `EXT-X-STREAM-INF` variants sorted ascending by BANDWIDTH. Taken verbatim
 * from `https://cdn.thechosen.media/videos/cmkaom6vg0000bca7bhwyicjj/master.m3u8`
 * on 2026-08-18, because the interleaving is the whole reason this rule is not
 * "find the tallest allowed one".
 */
const EP_101_LEVELS: LevelLike[] = [
  { height: 480, width: 854, bitrate: 1934005, videoCodec: "hvc1.1.6.L90.90" },
  { height: 480, width: 854, bitrate: 4523175, videoCodec: "avc1.4D401E" },
  { height: 720, width: 1280, bitrate: 7700959, videoCodec: "hvc1.1.6.L93.90" },
  { height: 1080, width: 1920, bitrate: 13609375, videoCodec: "hvc1.1.6.L120.90" },
  { height: 720, width: 1280, bitrate: 15965367, videoCodec: "avc1.4D401F" },
  { height: 1080, width: 1920, bitrate: 27147747, videoCodec: "avc1.4D4028" },
  { height: 1440, width: 2560, bitrate: 27767561, videoCodec: "hvc1.1.6.L150.90" },
  { height: 2160, width: 3840, bitrate: 28156853, videoCodec: "hvc1.1.6.L150.90" },
  { height: 1440, width: 2560, bitrate: 51891555, videoCodec: "avc1.4D4032" },
  { height: 2160, width: 3840, bitrate: 92507195, videoCodec: "avc1.4D4033" },
]

/** What the same master looks like in Chromium, where the player drops the
 *  HEVC renditions because the browser cannot decode them through MSE. */
const EP_101_H264_ONLY = EP_101_LEVELS.filter((l) => l.videoCodec?.startsWith("avc1"))

describe("isHlsSource", () => {
  it("recognises the client's own film addresses", () => {
    expect(isHlsSource("https://cdn.thechosen.media/videos/abc123/master.m3u8")).toBe(true)
  })

  it("ignores the query and fragment a signed address carries", () => {
    expect(isHlsSource("https://cdn/videos/x/master.m3u8?token=abc&exp=1#t=10")).toBe(true)
  })

  it("leaves plain files and recordings alone", () => {
    expect(isHlsSource("https://cdn/episode.mp4")).toBe(false)
    expect(isHlsSource("https://cdn/episode.webm")).toBe(false)
    expect(isHlsSource("blob:http://localhost:5173/9f2b")).toBe(false)
  })

  it("is false for nothing at all", () => {
    expect(isHlsSource(null)).toBe(false)
    expect(isHlsSource(undefined)).toBe(false)
    expect(isHlsSource("")).toBe(false)
  })
})

describe("capIndexForHeight", () => {
  it("stops below the first rendition taller than the cap, not at the tallest allowed one", () => {
    // Index 3 is HEVC 1080p, sitting BELOW H.264 720p at index 4. Picking the
    // tallest allowed index would return 4 and let the player climb through
    // 1080p on the way — which is exactly the load we are trying to avoid.
    expect(capIndexForHeight(EP_101_LEVELS, MAX_LEVEL_HEIGHT)).toBe(2)
  })

  it("keeps a real picture rather than the smallest one", () => {
    // Everything at or below the cap stays available, so 720p is reachable.
    const allowed = EP_101_LEVELS.slice(0, capIndexForHeight(EP_101_LEVELS) + 1)
    expect(Math.max(...allowed.map((l) => l.height ?? 0))).toBe(720)
  })

  it("lands on H.264 720p where the HEVC renditions were dropped", () => {
    expect(capIndexForHeight(EP_101_H264_ONLY)).toBe(1)
    expect(EP_101_H264_ONLY[1]?.height).toBe(720)
  })

  it("honours a smaller cap", () => {
    expect(capIndexForHeight(EP_101_LEVELS, 480)).toBe(1)
  })

  it("takes the smallest on offer when every rendition is too tall", () => {
    // A too-large picture beats no picture.
    expect(capIndexForHeight([{ height: 2160 }, { height: 4320 }], 720)).toBe(0)
  })

  it("treats a rendition that does not say its height as the ceiling", () => {
    expect(capIndexForHeight([{ height: 480 }, {}, { height: 720 }], 720)).toBe(0)
  })

  it("means no cap at all when there are no levels", () => {
    expect(capIndexForHeight([], 720)).toBe(-1)
  })
})
