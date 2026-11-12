// Test fixture: a synthetic MPEG2 Layer III stream whose frames carry their own
// ordinal, so a stub decoder can reconstruct exactly which part of a reference
// signal a given byte range covers — the same thing a real decoder does, with
// none of the codec.
//
// Not shipped behaviour; kept beside the code it exercises so the frame
// geometry here and in mp3-chunks.ts stay honest about the same spec.

/** MPEG2 Layer III, 16 kHz, 64 kbps, no padding, no CRC. */
export const FIXTURE_SAMPLE_RATE = 16_000
/** MPEG2 Layer III carries 576 samples per frame. */
export const FIXTURE_SAMPLES_PER_FRAME = 576
/** floor((576 / 8) * (64000 / 16000)) = 288 bytes, padding bit clear. */
export const FIXTURE_FRAME_BYTES = 288

/** Bytes of ID3v2 tag the fixture puts in front of the first frame. */
export const FIXTURE_ID3_BYTES = 10 + 64

/**
 * Build `frames` frames of synthetic MPEG audio behind an ID3v2 tag. Each
 * frame body opens with its own little-endian ordinal at byte 4.
 */
export function buildMp3Fixture(frames: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(FIXTURE_ID3_BYTES + frames * FIXTURE_FRAME_BYTES)
  out[0] = 0x49 // "I"
  out[1] = 0x44 // "D"
  out[2] = 0x33 // "3"
  out[3] = 0x03 // version
  // Syncsafe size of the 64 tag bytes that follow the 10-byte ID3 header.
  out[9] = 64
  for (let i = 0; i < frames; i++) {
    const at = FIXTURE_ID3_BYTES + i * FIXTURE_FRAME_BYTES
    out[at] = 0xff
    out[at + 1] = 0xf3 // sync | MPEG2 | Layer III | no CRC
    out[at + 2] = 0x88 // bitrate index 8 (64 kbps) | sample rate index 2 (16 kHz)
    out[at + 3] = 0x00 // stereo, no emphasis
    new DataView(out.buffer, at + 4, 4).setUint32(0, i, true)
  }
  return out
}

/** Read back the ordinal of the first frame in a fixture byte range. */
export function fixtureFrameOrdinal(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true)
}
