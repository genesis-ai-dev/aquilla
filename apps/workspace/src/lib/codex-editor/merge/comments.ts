// src/lib/codex-editor/merge/comments.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:389,397,413,497
import type { CodexComment } from "@/lib/codex-editor/types"

export function generateCommentId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function areCommentsDuplicate(a: CodexComment, b: CodexComment): boolean {
  if (a.id && b.id && a.id === b.id) return true
  return a.body === b.body && a.author?.name === b.author?.name
}

export function migrateComment(c: Partial<CodexComment> & { id?: string }): CodexComment {
  return {
    id: c.id || generateCommentId(),
    timestamp: c.timestamp ?? Date.now(),
    body: c.body ?? "",
    mode: c.mode ?? 0,
    deleted: c.deleted ?? false,
    author: c.author ?? { name: "unknown" },
  }
}
