/**
 * Runtime-neutral zip packing/unpacking for org egress.
 *
 * Shared verbatim by the packaging Web Worker (`zip.worker.ts`) and by the
 * main-thread inline fallback in `zip-worker-client.ts`, so both paths emit
 * byte-identical archives — the worker is a scheduling change, never a
 * format change.
 */

import JSZip from "jszip"
import type { EgressZipEntry } from "./build-project-export"

/** Worker protocol. `data` values (Blob / ArrayBuffer / Uint8Array / string)
 *  are all structured-cloneable, so entries cross the wire as-is. */
export type ZipWorkerPayload =
  | { op: "pack"; entries: readonly EgressZipEntry[] }
  | { op: "unpack"; bytes: ArrayBuffer }

export type ZipWorkerRequest = ZipWorkerPayload & { id: string }

export type ZipWorkerResponse =
  | { id: string; ok: true; blob: Blob }
  | { id: string; ok: true; entries: EgressZipEntry[] }
  | { id: string; ok: false; error: string }

/** Compressed output handed to blob storage this often (AQU-1862). Small
 *  enough that the heap never holds a meaningful slice of an org's zip, large
 *  enough that a multi-GB export isn't thousands of blob parts. */
export const ZIP_FLUSH_BYTES = 8 * 1024 * 1024

/**
 * DEFLATE the entries into one zip. The CPU-heavy half of an egress run.
 *
 * Streamed rather than generated in one go: JSZip pulls each entry's bytes as
 * the stream reaches it, and the compressed chunks are flushed into blob
 * storage every ZIP_FLUSH_BYTES, so an org zip no longer sits on the JS heap
 * in its entirety before the download starts (AQU-1862). Byte-for-byte the
 * same archive as generateAsync — same JSZip, same entry order, same codec.
 */
export async function packZip(entries: readonly EgressZipEntry[]): Promise<Blob> {
  const zip = new JSZip()
  for (const entry of entries) {
    zip.file(entry.path, entry.data)
  }

  const parts: Blob[] = []
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const flush = (): void => {
    if (pendingBytes === 0) return
    parts.push(new Blob(pending as BlobPart[]))
    pending = []
    pendingBytes = 0
  }

  await new Promise<void>((resolve, reject) => {
    zip
      .generateInternalStream({ type: "uint8array", compression: "DEFLATE" })
      .on("data", (chunk: Uint8Array) => {
        pending.push(chunk)
        pendingBytes += chunk.byteLength
        if (pendingBytes >= ZIP_FLUSH_BYTES) flush()
      })
      .on("error", reject)
      .on("end", () => {
        flush()
        resolve()
      })
      .resume()
  })
  return new Blob(parts, { type: "application/zip" })
}

/**
 * Inflate a cached per-project zip back into entries, directories dropped.
 *
 * Entries come back as Blobs, not typed arrays: a cache replay feeds straight
 * into the org zip, and a project's worth of inflated bytes on the heap is the
 * same crash this module is trying to avoid (AQU-1862).
 */
export async function unpackZip(bytes: ArrayBuffer): Promise<EgressZipEntry[]> {
  const zip = await JSZip.loadAsync(bytes)
  const paths = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const entries: EgressZipEntry[] = []
  for (const path of paths) {
    entries.push({ path, data: await zip.files[path].async("blob") })
  }
  return entries
}
