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

/** DEFLATE the entries into one zip. The CPU-heavy half of an egress run. */
export async function packZip(entries: readonly EgressZipEntry[]): Promise<Blob> {
  const zip = new JSZip()
  for (const entry of entries) {
    zip.file(entry.path, entry.data)
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" })
}

/** Inflate a cached per-project zip back into entries, directories dropped. */
export async function unpackZip(bytes: ArrayBuffer): Promise<EgressZipEntry[]> {
  const zip = await JSZip.loadAsync(bytes)
  const paths = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const entries: EgressZipEntry[] = []
  for (const path of paths) {
    entries.push({ path, data: await zip.files[path].async("uint8array") })
  }
  return entries
}
