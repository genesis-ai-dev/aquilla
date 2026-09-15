import type JSZip from "jszip"
import { MAX_SOURCE_ARTIFACT_BYTES } from "../../../shared/import-contract"
import type { ZipLiteArchive } from "./zip-lite"

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 1_000

interface LoadedZipMetadata {
  compressedSize?: number
  uncompressedSize?: number
}

interface LoadedZipEntry {
  dir: boolean
  name: string
  unsafeOriginalName?: string
  _data?: LoadedZipMetadata
}

export function assertSafeArchiveInputSize(byteLength: number, label: string): void {
  if (byteLength === 0) throw new Error(`${label} is empty.`)
  if (byteLength > MAX_SOURCE_ARTIFACT_BYTES) {
    throw new Error(`${label} exceeds the 95 MB import limit.`)
  }
}

/**
 * Validate central-directory metadata before any member is decompressed.
 * JSZip intentionally exposes loaded entry sizes only through its internal
 * data object; keep this small adapter isolated so every browser ZIP importer
 * applies the same bomb/path/entry-count policy.
 */
export function assertSafeZipArchive(archive: JSZip, label: string): void {
  const entries = Object.values(archive.files) as LoadedZipEntry[]
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`${label} contains too many archive entries (maximum ${MAX_ARCHIVE_ENTRIES.toLocaleString()}).`)
  }

  let totalUncompressed = 0
  let totalCompressed = 0
  for (const entry of entries) {
    if (entry.dir) continue
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
      throw new Error(`${label} contains an unsafe archive path: ${entry.unsafeOriginalName}`)
    }
    const uncompressed = entry._data?.uncompressedSize
    const compressed = entry._data?.compressedSize
    if (!Number.isSafeInteger(uncompressed) || uncompressed! < 0) {
      throw new Error(`${label} contains an entry with invalid size metadata: ${entry.name}`)
    }
    if (!Number.isSafeInteger(compressed) || compressed! < 0) {
      throw new Error(`${label} contains an entry with invalid compressed-size metadata: ${entry.name}`)
    }
    if (uncompressed! > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`${label} contains an archive entry larger than 128 MB: ${entry.name}`)
    }
    totalUncompressed += uncompressed!
    totalCompressed += compressed!
    if (totalUncompressed > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error(`${label} expands beyond the 512 MB safety limit.`)
    }
  }

  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_COMPRESSION_RATIO) {
    throw new Error(`${label} has an unsafe compression ratio.`)
  }
}

/**
 * The same bomb/path/entry-count policy for a `zip-lite` archive (AQU-1237).
 *
 * `zip-lite` reads the central directory verbatim rather than sanitizing paths
 * the way JSZip does, so traversal is rejected here by inspecting the recorded
 * name directly instead of comparing against a sanitized one. Sizes come from
 * the central directory and are therefore available BEFORE any member is
 * inflated — same guarantee the JSZip variant relies on.
 */
export function assertSafeZipLiteArchive(archive: ZipLiteArchive, label: string): void {
  if (archive.entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`${label} contains too many archive entries (maximum ${MAX_ARCHIVE_ENTRIES.toLocaleString()}).`)
  }

  let totalUncompressed = 0
  let totalCompressed = 0
  for (const entry of archive.entries) {
    if (isUnsafeArchivePath(entry.name)) {
      throw new Error(`${label} contains an unsafe archive path: ${entry.name}`)
    }
    if (entry.isDirectory) continue
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new Error(`${label} contains an entry with invalid size metadata: ${entry.name}`)
    }
    if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
      throw new Error(`${label} contains an entry with invalid compressed-size metadata: ${entry.name}`)
    }
    if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`${label} contains an archive entry larger than 128 MB: ${entry.name}`)
    }
    totalUncompressed += entry.uncompressedSize
    totalCompressed += entry.compressedSize
    if (totalUncompressed > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error(`${label} expands beyond the 512 MB safety limit.`)
    }
  }

  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_COMPRESSION_RATIO) {
    throw new Error(`${label} has an unsafe compression ratio.`)
  }
}

/** Absolute paths, drive letters, backslash separators, and `..` traversal. */
export function isUnsafeArchivePath(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return true
  if (/^[a-zA-Z]:/.test(name)) return true
  if (name.includes("\\")) return true
  return name.split("/").some((segment) => segment === "..")
}
