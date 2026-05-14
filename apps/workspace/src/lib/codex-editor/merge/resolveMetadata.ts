// src/lib/codex-editor/merge/resolveMetadata.ts
// Two-way merge for metadata.json. Same edit-ledger semantics as .codex
// file-level metadata, but operates on a flat record.

import type { EditHistory } from "@/lib/codex-editor/types"

function editKey(e: EditHistory): string {
  return `${e.timestamp}:${e.editMap.join(".")}:${JSON.stringify(e.value)}`
}

function unionEdits(a?: EditHistory[], b?: EditHistory[]): EditHistory[] {
  const byKey = new Map<string, EditHistory>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!byKey.has(editKey(e))) byKey.set(editKey(e), e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

export async function resolveMetadataTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ours = JSON.parse(ourBytes) as Record<string, unknown> & { edits?: EditHistory[] }
  const theirs = JSON.parse(theirBytes) as Record<string, unknown> & { edits?: EditHistory[] }

  const mergedEdits = unionEdits(ours.edits, theirs.edits)

  const out: Record<string, unknown> = { ...ours, ...theirs, edits: mergedEdits }

  const latestByRoot = new Map<string, EditHistory>()
  for (const e of mergedEdits) {
    const root = e.editMap[0]
    if (!root) continue
    const prev = latestByRoot.get(root)
    if (!prev || e.timestamp > prev.timestamp) latestByRoot.set(root, e)
  }
  for (const [root, e] of latestByRoot.entries()) {
    if (e.editMap.length === 1) out[root] = e.value
  }

  return JSON.stringify(out, null, 2)
}
