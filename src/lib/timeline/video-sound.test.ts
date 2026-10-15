import { describe, expect, it } from "vitest"

import { describeVideoSound, extractVideoSound, MAX_SOUND_OFFSET_SEC, type VideoSoundSource } from "./video-sound"
import { buildFragment, buildInit, decodeFixture } from "@/lib/video/__fixtures__/fmp4"
import type { AudioDecodeFn } from "@/lib/audio/speech-analysis"

// AQU-1681. WHY: a linked video's rows come from its OWN sound. For a streamed
// film that sound is one audio rendition of an HLS master, fetched a fragment
// at a time, decoded a minute at a time, stored as one file, and split at its
// pauses. These pin what the person would see go wrong if any step slipped:
// the wrong language, rows drifting off the picture over a long episode, a
// sound that starts somewhere else than the picture, a cancel that keeps
// downloading, and a direct video link that is not stored as it is.

const BASE = "https://cdn.example.test/videos/ep/"
const MASTER = `${BASE}master.m3u8`
/** 16 kHz track clock, 1000-tick samples: 16 samples = one second. */
const TIMESCALE = 16_000
const SAMPLE = 1000
const RATE = 16_000

/** One fragment per second; the pattern is speech (1) / silence (0). */
const PATTERN = [1, 1, 0, 1, 0, 0, 1, 1]

function fragments(pattern: readonly number[], startSec = 0) {
  return pattern.map((level, i) =>
    buildFragment({ decodeTime: (startSec + i) * TIMESCALE, sampleCount: 16, level }),
  )
}

const MASTER_TEXT = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="audio_en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English Audio Descriptions",LANGUAGE="en_ad",URI="audio_en_ad.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Spanish (Latin America)",LANGUAGE="es-419",URI="audio_es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,AUDIO="a"
video_480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,AUDIO="a"
video_720.m3u8
`

function mediaPlaylist(prefix: string, count: number, extinf = "1.0"): string {
  return [
    "#EXTM3U",
    `#EXT-X-MAP:URI="${prefix}/init.mp4"`,
    ...Array.from({ length: count }, (_, i) => `#EXTINF:${extinf},\n${prefix}/s${i}.m4s`),
    "#EXT-X-ENDLIST",
  ].join("\n")
}

interface Stream {
  routes: Map<string, () => Response>
  fetched: string[]
  fetchFn: typeof fetch
}

function stream(opts: { pictureStartSec?: number; pattern?: readonly number[]; extinf?: string } = {}): Stream {
  const pattern = opts.pattern ?? PATTERN
  const routes = new Map<string, () => Response>()
  const bytes = (b: Uint8Array) => () => new Response(b as BodyInit)
  const text = (s: string) => () => new Response(s)
  routes.set(MASTER, text(MASTER_TEXT))
  for (const lang of ["en", "es"]) {
    routes.set(`${BASE}audio_${lang}.m3u8`, text(mediaPlaylist(`a/${lang}`, pattern.length, opts.extinf)))
    routes.set(`${BASE}a/${lang}/init.mp4`, bytes(buildInit({ timescale: TIMESCALE, defaultSampleDuration: SAMPLE })))
    // The Spanish track is the same pattern, but silent where English speaks
    // its first line — so a test can tell which one was fetched.
    const frags = fragments(lang === "es" ? pattern.map((l, i) => (i === 0 ? 0 : l)) : pattern)
    frags.forEach((f, i) => routes.set(`${BASE}a/${lang}/s${i}.m4s`, bytes(f)))
  }
  routes.set(`${BASE}video_480.m3u8`, text(mediaPlaylist("v", pattern.length)))
  routes.set(`${BASE}v/init.mp4`, bytes(buildInit({ timescale: 25_000, handler: "vide", defaultSampleDuration: 1000 })))
  routes.set(`${BASE}v/s0.m4s`, bytes(buildFragment({
    decodeTime: Math.round((opts.pictureStartSec ?? 0) * 25_000), sampleCount: 25, level: 0,
  })))
  const fetched: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = String(input)
    fetched.push(url)
    const route = routes.get(url)
    return route ? route() : new Response("missing", { status: 404 })
  }) as typeof fetch
  return { routes, fetched, fetchFn }
}

/** A decoder that renders each fragment's level, plus `extra` loud samples of
 *  edge padding on every decode. */
function fixtureDecoder(extra = 0): AudioDecodeFn {
  return async (bytes, sampleRate = RATE) => {
    const channel = decodeFixture(bytes, sampleRate, TIMESCALE, SAMPLE, extra)
    return { channel, sampleRate, durationMs: (channel.length / sampleRate) * 1000 }
  }
}

const noYield = async () => {}

async function described(s: Stream, lang: string | null = "en"): Promise<VideoSoundSource> {
  return describeVideoSound(MASTER, lang, { fetchFn: s.fetchFn })
}

describe("describeVideoSound", () => {
  it("offers the film's languages without the audio-description track, defaulting to the source language", async () => {
    const s = stream()
    const source = await described(s, "es")
    expect(source.kind).toBe("stream")
    if (source.kind !== "stream") return
    expect(source.tracks.map((t) => t.name)).toEqual(["English", "Spanish (Latin America)"])
    expect(source.defaultTrackId).toBe(`${BASE}audio_es.m3u8`)
  })

  it("falls back to English when the source language is not on offer", async () => {
    const source = await described(stream(), "fr")
    expect(source.kind === "stream" && source.defaultTrackId).toBe(`${BASE}audio_en.m3u8`)
  })

  it("treats a link that is not a playlist as a file, without fetching it", async () => {
    const s = stream()
    expect(await describeVideoSound("https://files.example.test/ep.webm", "en", { fetchFn: s.fetchFn }))
      .toEqual({ kind: "file", url: "https://files.example.test/ep.webm" })
    expect(s.fetched).toEqual([])
  })
})

describe("extractVideoSound — a streamed film", () => {
  it("stores the chosen track's init and fragments, in order, as one audio/mp4 file, and finds its speech", async () => {
    const s = stream()
    const progress: (number | null)[] = []
    const out = await extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
      onProgress: (p) => progress.push(p.fraction),
    })
    expect(out.file.name).toBe("Episode 1 (English).m4a")
    expect(out.file.type).toBe("audio/mp4")
    const expected = [buildInit({ timescale: TIMESCALE, defaultSampleDuration: SAMPLE }), ...fragments(PATTERN)]
    expect(new Uint8Array(await out.file.arrayBuffer())).toEqual(
      Uint8Array.from(expected.flatMap((b) => [...b])),
    )
    // Speech 0–2 s, 3–4 s, 6–8 s, padded 50 ms each side by the splitter.
    expect(out.analysis).toEqual({
      durationMs: 8000,
      segments: [
        { startMs: 0, endMs: 2050 },
        { startMs: 2950, endMs: 4050 },
        { startMs: 5950, endMs: 8000 },
      ],
    })
    expect(progress.at(-1)).toBe(1)
    expect(s.fetched).not.toContain(`${BASE}audio_es.m3u8`)
  })

  it("fetches the track the maintainer picked instead of the default", async () => {
    const s = stream()
    const out = await extractVideoSound({
      source: await described(s),
      trackId: `${BASE}audio_es.m3u8`,
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
    })
    expect(out.file.name).toBe("Episode 1 (Spanish (Latin America)).m4a")
    // The Spanish track is silent in the first second.
    expect(out.analysis?.segments[0]).toEqual({ startMs: 950, endMs: 2050 })
  })

  it("cuts each minute to its fragments' declared length, so a padding decoder cannot slide later rows", async () => {
    const s = stream()
    const out = await extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      // 100 ms of loud padding after every 2-second chunk: untrimmed, the
      // last line would start 300 ms late and the file would run 8.4 s.
      decode: fixtureDecoder(1600),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
    })
    expect(out.analysis?.durationMs).toBe(8000)
    expect(out.analysis?.segments.at(-1)).toEqual({ startMs: 5950, endMs: 8000 })
  })

  it("measures the sound from its boxes, not from a playlist that rounds its durations", async () => {
    const s = stream({ extinf: "2" })
    const out = await extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
    })
    expect(out.analysis?.durationMs).toBe(8000)
  })

  it("refuses a sound that does not start with the picture, before fetching the rest of it", async () => {
    const s = stream({ pictureStartSec: 4 })
    await expect(extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
    })).rejects.toThrow("The video's sound starts 4.0 s away from its picture")
    expect(s.fetched).toContain(`${BASE}v/s0.m4s`)
    expect(s.fetched).not.toContain(`${BASE}a/en/s7.m4s`)
  })

  it("accepts a picture that starts within a couple of frames of the sound", async () => {
    const s = stream({ pictureStartSec: MAX_SOUND_OFFSET_SEC / 2 })
    await expect(extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
    })).resolves.toBeDefined()
  })

  it("stops fetching when cancelled", async () => {
    const s = stream()
    const ac = new AbortController()
    await expect(extractVideoSound({
      source: await described(s),
      baseName: "Episode 1",
      fetchFn: s.fetchFn,
      decode: fixtureDecoder(),
      yieldToEventLoop: noYield,
      chunkMs: 2000,
      signal: ac.signal,
      onProgress: (p) => { if ((p.fraction ?? 0) >= 0.25) ac.abort() },
    })).rejects.toThrow()
    const fragmentsFetched = s.fetched.filter((u) => u.includes("/a/en/s")).length
    expect(fragmentsFetched).toBeLessThan(PATTERN.length)
  })

  it("says so when the stream's sound is encrypted", async () => {
    const s = stream()
    s.routes.set(`${BASE}audio_en.m3u8`, () => new Response(
      `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXT-X-MAP:URI="a/en/init.mp4"\n#EXTINF:1,\na/en/s0.m4s\n`,
    ))
    await expect(extractVideoSound({
      source: await described(s), baseName: "E", fetchFn: s.fetchFn, decode: fixtureDecoder(), yieldToEventLoop: noYield,
    })).rejects.toThrow("encrypted")
  })
})

describe("extractVideoSound — a direct link to a video file", () => {
  it("downloads the file as it is, named and typed from the link, and leaves the analysis to the importer", async () => {
    const body = new Uint8Array(4096).fill(7)
    const fractions: (number | null)[] = []
    const fetchFn = (async () => new Response(body as BodyInit, {
      headers: { "content-type": "video/webm", "content-length": String(body.byteLength) },
    })) as typeof fetch
    const out = await extractVideoSound({
      source: { kind: "file", url: "https://files.example.test/Episode%201.webm" },
      baseName: "ignored",
      fetchFn,
      onProgress: (p) => fractions.push(p.fraction),
    })
    expect(out.file.name).toBe("Episode 1.webm")
    expect(out.file.type).toBe("video/webm")
    expect(out.file.size).toBe(4096)
    expect(out.analysis).toBeUndefined()
    expect(fractions.at(-1)).toBe(1)
  })

  it("explains a server that will not let the page read the file", async () => {
    const fetchFn = (async () => { throw new TypeError("Failed to fetch") }) as typeof fetch
    await expect(extractVideoSound({
      source: { kind: "file", url: "https://files.example.test/ep.mp4" },
      baseName: "x",
      fetchFn,
      retryDelaysMs: [0, 0],
    })).rejects.toThrow("Couldn't download this video")
  })
})
