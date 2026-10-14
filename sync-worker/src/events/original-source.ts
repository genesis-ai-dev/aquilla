// Shared original-blob resolve for AQU-656 download routes.
// Mirrors export-route.ts storage generations: R2 `r2_key` first, then
// legacy `raw_source` (UTF-8 text, or base64 for OOXML/IDML sidecars).

import { sourceArtifactDescriptor } from "../../../shared/import-contract"

const BASE64_INLINE_FORMATS = new Set(["docx", "pptx", "idml"])

/**
 * Whether a legacy inline `raw_source` for this format is base64 rather than
 * UTF-8 text — i.e. whether it can be *corrupt* rather than merely absent.
 */
export function isBase64InlineFormat(format: string): boolean {
  return BASE64_INLINE_FORMATS.has(format)
}

/** Decode a legacy base64 side-car, or `null` when the bytes are corrupt. */
export function decodeInlineOriginal(raw: string): Uint8Array | null {
  return decodeBase64(raw)
}

export interface SourceBlobRow {
  format: string
  raw_source: string | null
  r2_key: string | null
}

export type OriginalBytesResult =
  | { ok: true; bytes: Uint8Array; format: string; contentType: string }
  | { ok: false; status: number; message: string }

function decodeBase64(raw: string): Uint8Array | null {
  try {
    const cleaned = raw.replace(/\s/g, "")
    const b64 = atob(cleaned)
    const binary = new Uint8Array(b64.length)
    for (let i = 0; i < b64.length; i++) binary[i] = b64.charCodeAt(i)
    return binary
  } catch {
    return null
  }
}

export async function readOriginalSourceBytes(
  blob: SourceBlobRow,
  snapshots: R2Bucket,
): Promise<OriginalBytesResult> {
  const contentType = sourceArtifactDescriptor(blob.format).contentType
  if (blob.r2_key) {
    const object = await snapshots.get(blob.r2_key)
    if (!object) {
      return { ok: false, status: 404, message: "source bytes missing from storage — re-import" }
    }
    return {
      ok: true,
      bytes: new Uint8Array(await object.arrayBuffer()),
      format: blob.format,
      contentType,
    }
  }
  if (blob.raw_source == null || blob.raw_source === "") {
    return { ok: false, status: 404, message: "no source bytes recorded — re-import to enable download" }
  }
  if (BASE64_INLINE_FORMATS.has(blob.format)) {
    const binary = decodeBase64(blob.raw_source)
    if (!binary) {
      return { ok: false, status: 500, message: "side-car bytes corrupted — re-import to restore" }
    }
    return { ok: true, bytes: binary, format: blob.format, contentType }
  }
  return {
    ok: true,
    bytes: new TextEncoder().encode(blob.raw_source),
    format: blob.format,
    contentType,
  }
}

/**
 * AQU-1863: streaming counterpart of `readOriginalSourceBytes`. Returns the
 * R2 object's body as a stream — never buffered — so a bundle writer can pipe
 * a 50 MB original through without holding it. Legacy inline blobs are small
 * by construction and come back as bytes.
 *
 * Returns `null` when the blob has no bytes (missing R2 object, no recorded
 * source, corrupted side-car); callers that already reported a 404 for the
 * empty case skip the entry instead.
 */
export async function openOriginalSourceStream(
  blob: SourceBlobRow,
  snapshots: R2Bucket,
): Promise<ReadableStream<Uint8Array> | Uint8Array | null> {
  if (blob.r2_key) {
    const object = await snapshots.get(blob.r2_key)
    return object?.body ?? null
  }
  if (blob.raw_source == null || blob.raw_source === "") return null
  if (BASE64_INLINE_FORMATS.has(blob.format)) {
    return decodeBase64(blob.raw_source)
  }
  return new TextEncoder().encode(blob.raw_source)
}
