import { describe, it, expect } from "vitest"
import {
  blobRangeReader,
  id3v2Length,
  parseMp3FrameHeader,
  planMp3Chunks,
  type ByteRangeReader,
} from "./mp3-chunks"
import {
  buildMp3Fixture,
  FIXTURE_FRAME_BYTES,
  FIXTURE_ID3_BYTES,
  FIXTURE_SAMPLES_PER_FRAME,
  FIXTURE_SAMPLE_RATE,
} from "./__fixtures__/mp3-stream"

// WHY: AQU-1857 cuts a long MP3 into separately-decodable byte ranges so the
// import never allocates whole-file PCM. The cut points come from MPEG frame
// headers, so these tests pin the header arithmetic and the walk: a range that
// starts mid-frame decodes as garbage, and a walk that stops early would
// silently drop the tail of a recording.

function readerFor(bytes: Uint8Array): ByteRangeReader {
  return async (start, end) => bytes.subarray(start, end)
}

describe("id3v2Length", () => {
  it("is 0 when there is no tag", () => {
    expect(id3v2Length(new Uint8Array(32))).toBe(0)
  })

  it("decodes the syncsafe size, header included", () => {
    expect(id3v2Length(buildMp3Fixture(1))).toBe(FIXTURE_ID3_BYTES)
  })

  it("adds the footer when the flag is set", () => {
    const bytes = buildMp3Fixture(1)
    bytes[5] = 0x10
    expect(id3v2Length(bytes)).toBe(FIXTURE_ID3_BYTES + 10)
  })
})

describe("parseMp3FrameHeader", () => {
  it("reads length, samples and rate off a real header", () => {
    const bytes = buildMp3Fixture(1)
    expect(parseMp3FrameHeader(bytes, FIXTURE_ID3_BYTES)).toEqual({
      length: FIXTURE_FRAME_BYTES,
      samples: FIXTURE_SAMPLES_PER_FRAME,
      sampleRate: FIXTURE_SAMPLE_RATE,
    })
  })

  it("computes MPEG1 Layer III geometry (44.1 kHz, 128 kbps)", () => {
    // 0xFF 0xFB = sync | MPEG1 | Layer III | no CRC; 0x90 = bitrate index 9
    // (128 kbps) | sample rate index 0 (44100).
    const header = Uint8Array.from([0xff, 0xfb, 0x90, 0x00])
    expect(parseMp3FrameHeader(header, 0)).toEqual({ length: 417, samples: 1152, sampleRate: 44100 })
  })

  it("folds a padded frame’s extra byte into the length", () => {
    const header = Uint8Array.from([0xff, 0xfb, 0x92, 0x00]) // padding bit set
    expect(parseMp3FrameHeader(header, 0)?.length).toBe(418)
  })

  it("rejects non-headers: no sync, reserved version/layer, free/invalid bitrate, reserved rate", () => {
    expect(parseMp3FrameHeader(Uint8Array.from([0x00, 0x00, 0x00, 0x00]), 0)).toBeNull()
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xeb, 0x90, 0x00]), 0)).toBeNull() // version reserved
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xf9, 0x90, 0x00]), 0)).toBeNull() // layer reserved
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xfb, 0x00, 0x00]), 0)).toBeNull() // bitrate free
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xfb, 0xf0, 0x00]), 0)).toBeNull() // bitrate invalid
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xfb, 0x9c, 0x00]), 0)).toBeNull() // rate reserved
  })

  it("rejects a truncated header", () => {
    expect(parseMp3FrameHeader(Uint8Array.from([0xff, 0xfb, 0x90]), 0)).toBeNull()
  })
})

describe("planMp3Chunks", () => {
  const CHUNK_MS = 100
  /** 100 ms at 16 kHz is 1600 samples, so a chunk closes on frame 3 (1728). */
  const FRAMES_PER_CHUNK = 3

  it("cuts only at frame boundaries, covering the whole stream exactly once", async () => {
    const frames = 10
    const bytes = buildMp3Fixture(frames)
    const plan = await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)
    expect(plan).not.toBeNull()
    const { chunks, sampleRate, samples } = plan!

    expect(sampleRate).toBe(FIXTURE_SAMPLE_RATE)
    expect(samples).toBe(frames * FIXTURE_SAMPLES_PER_FRAME)
    expect(chunks[0].start).toBe(FIXTURE_ID3_BYTES)
    expect(chunks[chunks.length - 1].end).toBe(bytes.length)

    let cursor = FIXTURE_ID3_BYTES
    for (const chunk of chunks) {
      expect(chunk.start).toBe(cursor)
      expect((chunk.end - chunk.start) % FIXTURE_FRAME_BYTES).toBe(0)
      expect(chunk.samples).toBe(((chunk.end - chunk.start) / FIXTURE_FRAME_BYTES) * FIXTURE_SAMPLES_PER_FRAME)
      cursor = chunk.end
    }
    expect(chunks.map((c) => (c.end - c.start) / FIXTURE_FRAME_BYTES)).toEqual([3, 3, 3, 1])
  })

  it("derives duration from the frame headers", async () => {
    const bytes = buildMp3Fixture(FRAMES_PER_CHUNK)
    const plan = await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)
    expect(plan!.durationMs).toBeCloseTo((FRAMES_PER_CHUNK * FIXTURE_SAMPLES_PER_FRAME * 1000) / FIXTURE_SAMPLE_RATE, 6)
  })

  it("ends the walk at a trailing tag instead of failing", async () => {
    const audio = buildMp3Fixture(4)
    const bytes = new Uint8Array(audio.length + 128)
    bytes.set(audio)
    bytes.set(Uint8Array.from([0x54, 0x41, 0x47]), audio.length) // "TAG" (ID3v1)
    const plan = await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)
    expect(plan!.samples).toBe(4 * FIXTURE_SAMPLES_PER_FRAME)
    expect(plan!.chunks[plan!.chunks.length - 1].end).toBe(audio.length)
  })

  it("finds the first frame when the leading bytes are junk rather than a tag", async () => {
    const audio = buildMp3Fixture(4).subarray(FIXTURE_ID3_BYTES)
    const bytes = new Uint8Array(5 + audio.length)
    // A lone 0xFF in the junk must not be mistaken for a frame.
    bytes.set(Uint8Array.from([0x00, 0xff, 0x01, 0x02, 0x03]))
    bytes.set(audio, 5)
    const plan = await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)
    expect(plan!.chunks[0].start).toBe(5)
    expect(plan!.samples).toBe(4 * FIXTURE_SAMPLES_PER_FRAME)
  })

  it("returns null for bytes that are not an MPEG stream", async () => {
    const bytes = new Uint8Array(4096)
    expect(await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)).toBeNull()
  })

  it("returns null rather than guessing when the sample rate changes mid-stream", async () => {
    const bytes = buildMp3Fixture(6)
    // Re-point frame 3 at 24 kHz (sample rate index 1).
    bytes[FIXTURE_ID3_BYTES + 3 * FIXTURE_FRAME_BYTES + 2] = 0x84
    expect(await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)).toBeNull()
  })

  it("returns null for an empty or zero-length request", async () => {
    const bytes = buildMp3Fixture(2)
    expect(await planMp3Chunks(readerFor(bytes), 0, CHUNK_MS)).toBeNull()
    expect(await planMp3Chunks(readerFor(bytes), bytes.length, 0)).toBeNull()
  })

  it("walks a Blob through blobRangeReader the same way", async () => {
    const bytes = buildMp3Fixture(7)
    const blob = new Blob([bytes])
    const fromBlob = await planMp3Chunks(blobRangeReader(blob), blob.size, CHUNK_MS)
    const fromBytes = await planMp3Chunks(readerFor(bytes), bytes.length, CHUNK_MS)
    expect(fromBlob).toEqual(fromBytes)
  })
})
