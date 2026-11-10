// Shared plumbing for the format filters (AQU-2384).
//
// Each filter is a thin adapter: it calls the SAME parser from `../../parsers/`
// and the SAME exporter from `../../export/exporters/` the app already calls,
// and only normalizes their two different shapes onto one contract. Anything
// here that looks like logic is a shape conversion, not a behaviour change —
// that is what keeps every per-format test passing untouched.

import type { FormatSkeleton, FormatSource } from "../contract"

/** Build the skeleton a filter hands back from its own identity. */
export function skeletonFor(
  filter: { id: string; walkVersion: number },
  source: FormatSource,
): FormatSkeleton {
  return { formatId: filter.id, walkVersion: filter.walkVersion, source }
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * A filter whose `parse` needs the artifact's bytes refuses text, and vice
 * versa, rather than guessing an encoding. The skeleton records which it got,
 * so a build never has to guess either.
 */
export function requireBytes(formatId: string, source: FormatSource): ArrayBuffer {
  if (source.kind !== "bytes") {
    throw new Error(`${formatId} is a binary format: parse it from bytes, not text`)
  }
  return source.bytes
}

/**
 * Text for a text format. Bytes are decoded as UTF-8 rather than refused:
 * every caller that has bytes for a .srt/.vtt/.html/.xliff got them off a
 * file input or R2, and the parsers these wrap have always taken a string.
 * (Honouring a declared encoding or a BOM is AQU-2383's, not this seam's.)
 */
export function requireText(source: FormatSource): string {
  if (source.kind === "text") return source.text
  return new TextDecoder().decode(source.bytes)
}
