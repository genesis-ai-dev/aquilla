import type JSZip from "jszip"
import { MAX_SOURCE_ARTIFACT_BYTES } from "../../../shared/import-contract"

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
