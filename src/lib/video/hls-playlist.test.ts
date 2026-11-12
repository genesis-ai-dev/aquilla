import { describe, expect, it } from "vitest"

import {
  cheapestVariantFor,
  isMasterPlaylist,
  parseAttributes,
  parseHlsMaster,
  parseHlsMediaPlaylist,
} from "./hls-playlist"

// AQU-1681. WHY: making rows from a streamed film's own sound means fetching
// ONE audio rendition's fragments ourselves — hls.js plays them but never
// hands them out. These pin the playlist reading on the shape of the client's
// real masters (episode 101, read 2026-10-15), trimmed to the lines that
// matter: quoted attribute values with commas in them, relative URIs, and the
// audio-description rendition sitting next to English.

const MASTER_URL = "https://cdn.example.test/videos/ep101/master.m3u8"

const MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Amharic",LANGUAGE="am-ET",URI="audio_am-ET_fmp4.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="audio_en_fmp4.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English Audio Descriptions",LANGUAGE="en_ad",URI="audio_en_ad_fmp4.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="Main",LANGUAGE="en",DEFAULT=YES
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="SUBTITLE",NAME="English",LANGUAGE="en",URI="subs_en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=15965367,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="SUBTITLE"
video_h264_1280x720_fmp4.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1934005,CODECS="hvc1.1.6.L90.90,mp4a.40.2",RESOLUTION=854x480,AUDIO="audio",SUBTITLES="SUBTITLE"
video_h265_854x480_fmp4.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4523175,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=854x480,AUDIO="audio",SUBTITLES="SUBTITLE"
video_h264_854x480_fmp4.m3u8
`

describe("parseAttributes", () => {
  it("keeps a quoted value whole, commas and all", () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.4D401F,mp4a.40.2",AUDIO="audio"')).toEqual({
      BANDWIDTH: "1",
      CODECS: "avc1.4D401F,mp4a.40.2",
      AUDIO: "audio",
    })
  })
})

describe("parseHlsMaster", () => {
  const master = parseHlsMaster(MASTER, MASTER_URL)

  it("recognises a master by its variants", () => {
    expect(isMasterPlaylist(MASTER)).toBe(true)
    expect(isMasterPlaylist("#EXTM3U\n#EXTINF:4,\na.m4s\n")).toBe(false)
  })

  it("lists every audio rendition that has its own playlist, with absolute addresses", () => {
    expect(master.audio.map((a) => [a.name, a.lang, a.uri])).toEqual([
      ["Amharic", "am-ET", "https://cdn.example.test/videos/ep101/audio_am-ET_fmp4.m3u8"],
      ["English", "en", "https://cdn.example.test/videos/ep101/audio_en_fmp4.m3u8"],
      ["English Audio Descriptions", "en_ad", "https://cdn.example.test/videos/ep101/audio_en_ad_fmp4.m3u8"],
    ])
    expect(master.audio[1]).toMatchObject({ autoselect: true, default: false, groupId: "audio" })
  })

  it("leaves out a rendition muxed into the picture (no URI): there is no separate sound", () => {
    expect(master.audio.find((a) => a.name === "Main")).toBeUndefined()
  })

  it("reads the variants and picks the cheapest one that plays with a rendition", () => {
    expect(master.variants).toHaveLength(3)
    expect(cheapestVariantFor(master, master.audio[1]!)?.uri).toBe(
      "https://cdn.example.test/videos/ep101/video_h265_854x480_fmp4.m3u8",
    )
  })
})

describe("parseHlsMediaPlaylist", () => {
  const URL_ = "https://cdn.example.test/videos/ep101/audio_en_fmp4.m3u8"

  it("reads the init segment and each fragment with its duration", () => {
    const parsed = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="audio/en/init.mp4"
#EXTINF:3.989333333333333,
audio/en/audio_en_0.m4s
#EXTINF:4.010666666666666,
audio/en/audio_en_1.m4s
#EXT-X-ENDLIST
`, URL_)
    expect(parsed.encrypted).toBe(false)
    expect(parsed.init).toEqual({ url: "https://cdn.example.test/videos/ep101/audio/en/init.mp4" })
    expect(parsed.segments).toEqual([
      { url: "https://cdn.example.test/videos/ep101/audio/en/audio_en_0.m4s", durationSec: 3.989333333333333 },
      { url: "https://cdn.example.test/videos/ep101/audio/en/audio_en_1.m4s", durationSec: 4.010666666666666 },
    ])
  })

  it("reads byte ranges, including one that continues from the previous fragment", () => {
    const parsed = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="600@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@600
all.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:900
all.mp4
`, URL_)
    expect(parsed.init?.byteRange).toEqual({ offset: 0, length: 600 })
    expect(parsed.segments.map((s) => s.byteRange)).toEqual([
      { offset: 600, length: 1000 },
      { offset: 1600, length: 900 },
    ])
  })

  it("flags an encrypted playlist and a TS one (no init segment)", () => {
    const parsed = parseHlsMediaPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
seg0.ts
`, URL_)
    expect(parsed.encrypted).toBe(true)
    expect(parsed.init).toBeNull()
  })
})
