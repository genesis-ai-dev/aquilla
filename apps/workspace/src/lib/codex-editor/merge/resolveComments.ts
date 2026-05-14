// src/lib/codex-editor/merge/resolveComments.ts
// Two-way merge for comments.json. Ported from codex-editor/src/projectManager/
// utils/merge/resolvers.ts:1277-1611 adapted for the object-map file shape
// used by the web app (Record<threadId, CodexCommentThread>).

import type {
  CodexCommentsFile, CodexCommentThread, CodexComment,
} from "@/lib/codex-editor/types"

type EventEntry = { timestamp: number; author: { name: string } }

function unionEvents<T extends EventEntry>(a?: T[], b?: T[]): T[] {
  const byKey = new Map<string, T>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    byKey.set(`${e.timestamp}:${e.author?.name ?? ""}`, e)
  }
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp)
}

function mergeThread(ours: CodexCommentThread, theirs: CodexCommentThread): CodexCommentThread {
  const byId = new Map<string, CodexComment>()
  const sigSeen = new Set<string>()
  const sig = (c: CodexComment) => `${c.body}|${c.author?.name ?? ""}`

  for (const cmt of ours.comments) {
    byId.set(cmt.id || sig(cmt), cmt)
    sigSeen.add(sig(cmt))
  }
  for (const cmt of theirs.comments) {
    const key = cmt.id || sig(cmt)
    if (byId.has(key)) continue
    if (!cmt.id && sigSeen.has(sig(cmt))) continue
    byId.set(key, cmt)
    sigSeen.add(sig(cmt))
  }

  const ourLatest = ours.comments.reduce((m, c) => Math.max(m, c.timestamp), 0)
  const theirLatest = theirs.comments.reduce((m, c) => Math.max(m, c.timestamp), 0)
  const base = theirLatest > ourLatest ? { ...theirs } : { ...ours }

  return {
    ...base,
    comments: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp),
    deletionEvent: unionEvents(ours.deletionEvent, theirs.deletionEvent),
    resolvedEvent: unionEvents(ours.resolvedEvent, theirs.resolvedEvent),
  }
}

export async function resolveCommentsTwoWay(
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  if (!ourBytes) return theirBytes
  if (!theirBytes) return ourBytes

  const ours: CodexCommentsFile = JSON.parse(ourBytes)
  const theirs: CodexCommentsFile = JSON.parse(theirBytes)

  const merged: CodexCommentsFile = { ...ours }
  for (const [id, theirThread] of Object.entries(theirs)) {
    const ourThread = merged[id]
    merged[id] = ourThread ? mergeThread(ourThread, theirThread) : theirThread
  }

  return JSON.stringify(merged, null, 2)
}
