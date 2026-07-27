import type { CodexCommentsFile, CodexCommentThread } from "./types";
import type { CommentThread, CommentMessage } from "@/lib/parsers/types";

export function parseCodexComments(raw: string): CodexCommentsFile {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("comments.json must be a JSON object");
  }
  return parsed as CodexCommentsFile;
}

function isDeleted(thread: CodexCommentThread): boolean {
  const latest = thread.deletionEvent?.[thread.deletionEvent.length - 1];
  return !!latest?.deleted;
}

function isResolved(thread: CodexCommentThread): boolean {
  const latest = thread.resolvedEvent?.[thread.resolvedEvent.length - 1];
  return !!latest?.resolved;
}

function mapMessage(c: CodexCommentThread["comments"][number]): CommentMessage {
  return {
    id: c.id,
    author: c.author?.name || "unknown",
    authorType: "user",
    text: c.body,
    timestamp: new Date(c.timestamp).toISOString(),
  };
}

export function mapCodexCommentsToThreads(
  file: CodexCommentsFile
): Record<string, CommentThread[]> {
  const out: Record<string, CommentThread[]> = {};
  for (const thread of Object.values(file)) {
    if (isDeleted(thread)) continue;
    const cellId = thread.cellId?.cellId;
    if (!cellId) continue;
    const resolved = isResolved(thread);
    const resolvedEvt = resolved ? thread.resolvedEvent?.[thread.resolvedEvent.length - 1] : undefined;
    const mapped: CommentThread = {
      id: thread.id,
      status: resolved ? "resolved" : "open",
      createdAt: thread.comments[0] ? new Date(thread.comments[0].timestamp).toISOString() : new Date().toISOString(),
      resolvedAt: resolvedEvt ? new Date(resolvedEvt.timestamp).toISOString() : undefined,
      resolvedBy: resolvedEvt?.author?.name,
      // AQU-692: git-imported threads carry no target-text snapshot — unknown
      // baseline, so never flag them stale (null, not "").
      createdForTranslated: null,
      messages: thread.comments.filter(c => !c.deleted).map(mapMessage),
    };
    (out[cellId] ??= []).push(mapped);
  }
  return out;
}
