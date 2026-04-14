import { useCallback } from "react"
import * as Y from "yjs"
import { v4 as uuid } from "uuid"
import type { CommentThread, CommentMessage } from "@/lib/parsers/types"
import { extractMentions } from "@/lib/comments/comment-helpers"

function makeMessage(text: string, author: string): CommentMessage {
  return {
    id: uuid(),
    author: author || "anonymous",
    authorType: author && author !== "anonymous" ? "user" : "anonymous",
    text,
    timestamp: new Date().toISOString(),
    mentions: extractMentions(text),
  }
}

function getOrCreateThreadsArray(cell: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let threads = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
  if (!threads) {
    threads = new Y.Array<Y.Map<unknown>>()
    cell.set("threads", threads)
  }
  return threads
}

export function useComments(doc: Y.Doc | null, username: string) {
  const addThread = useCallback((cellId: string, firstMessage: string) => {
    if (!doc) return
    const cellsMap = doc.getMap("cells")
    const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
    if (!cell) return
    const translated = (cell.get("translated") as string) || ""

    doc.transact(() => {
      const threads = getOrCreateThreadsArray(cell)
      const thread = new Y.Map<unknown>()
      thread.set("id", uuid())
      thread.set("status", "open")
      thread.set("createdAt", new Date().toISOString())
      thread.set("createdForTranslated", translated)
      thread.set("messages", [makeMessage(firstMessage, username)] as CommentMessage[])
      threads.push([thread])
    })
  }, [doc, username])

  const addMessage = useCallback((cellId: string, threadId: string, text: string) => {
    if (!doc) return
    doc.transact(() => {
      const cellsMap = doc.getMap("cells")
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) return
      const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
      if (!threadsArr) return
      for (let i = 0; i < threadsArr.length; i++) {
        const t = threadsArr.get(i)
        if (t.get("id") === threadId) {
          const messages = (t.get("messages") as CommentMessage[] | undefined) || []
          t.set("messages", [...messages, makeMessage(text, username)])
          return
        }
      }
    })
  }, [doc, username])

  const resolveThread = useCallback((cellId: string, threadId: string, closingMessage?: string) => {
    if (!doc) return
    doc.transact(() => {
      const cellsMap = doc.getMap("cells")
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) return
      const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
      if (!threadsArr) return
      for (let i = 0; i < threadsArr.length; i++) {
        const t = threadsArr.get(i)
        if (t.get("id") === threadId) {
          if (closingMessage && closingMessage.trim()) {
            const messages = (t.get("messages") as CommentMessage[] | undefined) || []
            t.set("messages", [...messages, makeMessage(closingMessage, username)])
          }
          t.set("status", "resolved")
          t.set("resolvedAt", new Date().toISOString())
          t.set("resolvedBy", username || "anonymous")
          return
        }
      }
    })
  }, [doc, username])

  const reopenThread = useCallback((cellId: string, threadId: string) => {
    if (!doc) return
    doc.transact(() => {
      const cellsMap = doc.getMap("cells")
      const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
      if (!cell) return
      const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
      if (!threadsArr) return
      for (let i = 0; i < threadsArr.length; i++) {
        const t = threadsArr.get(i)
        if (t.get("id") === threadId) {
          t.set("status", "open")
          t.set("resolvedAt", undefined)
          t.set("resolvedBy", undefined)
          return
        }
      }
    })
  }, [doc])

  return { addThread, addMessage, resolveThread, reopenThread }
}

export function extractThreadsFromCell(cell: Y.Map<unknown>): CommentThread[] {
  const threadsArr = cell.get("threads") as Y.Array<Y.Map<unknown>> | undefined
  if (!threadsArr) return []
  const result: CommentThread[] = []
  for (let i = 0; i < threadsArr.length; i++) {
    const t = threadsArr.get(i)
    result.push({
      id: t.get("id") as string,
      status: (t.get("status") as "open" | "resolved") || "open",
      createdAt: (t.get("createdAt") as string) || "",
      resolvedAt: t.get("resolvedAt") as string | undefined,
      resolvedBy: t.get("resolvedBy") as string | undefined,
      createdForTranslated: (t.get("createdForTranslated") as string) || "",
      messages: (t.get("messages") as CommentMessage[] | undefined) || [],
    })
  }
  return result
}
