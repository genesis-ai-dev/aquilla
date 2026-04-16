// src/lib/lfs/pointer.ts
// Port of codex-editor/src/utils/lfsHelpers.ts:68-97. Pure functions, no I/O.

export interface LfsPointer {
  oid: string
  size: number
  version: string
}

export function parsePointerContent(content: string): LfsPointer | null {
  const versionMatch = content.match(/version (https:\/\/git-lfs\.github\.com\/spec\/v\d+)/)
  if (!versionMatch) return null

  const oidMatch = content.match(/oid sha256:([a-f0-9]{64})/i)
  if (!oidMatch) return null

  const sizeMatch = content.match(/size (\d+)/)
  if (!sizeMatch) return null

  const size = Number.parseInt(sizeMatch[1], 10)
  if (!Number.isFinite(size)) return null

  return {
    version: versionMatch[1],
    oid: oidMatch[1].toLowerCase(),
    size,
  }
}

export function isLfsPointerContent(data: Uint8Array): boolean {
  // Cheap length guard: real LFS pointers are ~150 bytes, use 400 as a
  // generous cutoff before attempting to decode.
  if (data.length > 400) return false
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
  return text.includes("version https://git-lfs.github.com/spec/v1")
}
