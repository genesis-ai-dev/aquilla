import { useEffect, useState, useMemo, useCallback } from "react"
import { useParams, useNavigate } from "react-router-dom"
import * as Y from "yjs"
import { ArrowLeft, FileText, MessageCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { collectExportCells, loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
import { getProject } from "@/lib/store/project-index"
import { extractThreadsFromCell, useComments } from "@/hooks/useComments"
import { CommentThread } from "./CommentThread"
import type { ProjectRecord, CommentThread as ThreadData } from "@/lib/parsers/types"

interface FileThreadEntry {
  fileId: string
  fileName: string
  items: {
    cellId: string
    cellContext: string
    original: string
    translated: string
    threads: ThreadData[]
  }[]
}

export function CommentsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [fileThreads, setFileThreads] = useState<FileThreadEntry[]>([])
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("open")
  const [search, setSearch] = useState("")
  const [activeFileFilter, setActiveFileFilter] = useState<string>("all")
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const p = await getProject(id)
      if (cancelled) return
      if (!p) { setLoading(false); return }
      setProject(p)

      const collected: FileThreadEntry[] = []
      for (const fileRef of p.files) {
        const data = await collectExportCells(fileRef.id)
        if (cancelled) return

        const handle = loadFileDoc(fileRef.id)
        await new Promise<void>((resolve) => {
          if (handle.persistence.synced) resolve()
          else handle.persistence.once("synced", () => resolve())
        })
        if (cancelled) { destroyFileDoc(handle); return }

        const cellsMap = handle.doc.getMap("cells")
        const items: FileThreadEntry["items"] = []
        for (const cell of data.cells) {
          const yCell = cellsMap.get(cell.id) as Y.Map<unknown> | undefined
          if (!yCell) continue
          const threads = extractThreadsFromCell(yCell)
          if (threads.length === 0) continue
          items.push({
            cellId: cell.id,
            cellContext: cell.context,
            original: cell.original,
            translated: cell.translated,
            threads,
          })
        }
        destroyFileDoc(handle)

        if (items.length > 0) {
          collected.push({ fileId: fileRef.id, fileName: fileRef.name, items })
        }
      }
      if (!cancelled) {
        setFileThreads(collected)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [id, refreshKey])

  const filtered = useMemo(() => {
    const lowerSearch = search.trim().toLowerCase()
    return fileThreads
      .filter((f) => activeFileFilter === "all" || f.fileId === activeFileFilter)
      .map((f) => ({
        ...f,
        items: f.items
          .map((item) => ({
            ...item,
            threads: item.threads.filter((t) => {
              if (filter !== "all" && t.status !== filter) return false
              if (lowerSearch) {
                const hay = (item.original + " " + item.translated + " " + t.messages.map((m) => m.text).join(" ")).toLowerCase()
                if (!hay.includes(lowerSearch)) return false
              }
              return true
            }),
          }))
          .filter((item) => item.threads.length > 0),
      }))
      .filter((f) => f.items.length > 0)
  }, [fileThreads, filter, search, activeFileFilter])

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/project/${id}`)}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Editor
        </Button>
        <h2 className="font-semibold">Comments</h2>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1 rounded border p-0.5">
            {(["open", "resolved", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-0.5 text-xs ${filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
              >
                {f}
              </button>
            ))}
          </div>
          <select
            value={activeFileFilter}
            onChange={(e) => setActiveFileFilter(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="all">All files</option>
            {fileThreads.map((f) => (
              <option key={f.fileId} value={f.fileId}>{f.fileName}</option>
            ))}
          </select>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="max-w-xs text-xs"
          />
        </div>

        {filtered.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              <MessageCircle className="mx-auto mb-2 h-8 w-8 opacity-30" />
              No comments matching filters.
            </CardContent>
          </Card>
        ) : (
          filtered.map((file) => (
            <div key={file.fileId} className="space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <FileText className="h-4 w-4 text-muted-foreground" />
                {file.fileName}
              </div>
              {file.items.map((item) => (
                <Card key={item.cellId}>
                  <CardContent className="p-3">
                    <button
                      onClick={() => navigate(`/project/${id}`)}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      {item.cellContext}{item.cellContext && " · "}{item.original.slice(0, 80)}
                    </button>
                    {item.translated && (
                      <p className="mt-0.5 text-xs">{item.translated.slice(0, 120)}</p>
                    )}
                    <div className="mt-2 space-y-2">
                      {item.threads.map((t) => (
                        <PageThread
                          key={t.id}
                          fileId={file.fileId}
                          cellId={item.cellId}
                          thread={t}
                          currentTranslated={item.translated}
                          username={project?.username || "anonymous"}
                          onChange={() => setRefreshKey((k) => k + 1)}
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))
        )}
      </main>
    </div>
  )
}

// Inline wrapper: mounts a short-lived Y.Doc per mutation to apply thread changes.
// Not as fast as the live drawer, but acceptable for a review page.
function PageThread({ fileId, cellId, thread, currentTranslated, username, onChange }: {
  fileId: string
  cellId: string
  thread: ThreadData
  currentTranslated: string
  username: string
  onChange: () => void
}) {
  const [activeDoc, setActiveDoc] = useState<Y.Doc | null>(null)
  const [handleRef, setHandleRef] = useState<ReturnType<typeof loadFileDoc> | null>(null)

  useEffect(() => {
    const handle = loadFileDoc(fileId)
    let cancelled = false
    ;(async () => {
      await new Promise<void>((resolve) => {
        if (handle.persistence.synced) resolve()
        else handle.persistence.once("synced", () => resolve())
      })
      if (cancelled) { destroyFileDoc(handle); return }
      setActiveDoc(handle.doc)
      setHandleRef(handle)
    })()
    return () => {
      cancelled = true
      if (handleRef) destroyFileDoc(handleRef)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  const hook = useComments(activeDoc, username)

  const handleChange = useCallback(() => {
    // Give Yjs a moment to flush, then ask parent to reload
    setTimeout(onChange, 100)
  }, [onChange])

  return (
    <CommentThread
      thread={thread}
      currentTranslated={currentTranslated}
      onReply={(text) => {
        hook.addMessage(cellId, thread.id, text)
        handleChange()
      }}
      onResolve={(msg) => {
        hook.resolveThread(cellId, thread.id, msg)
        handleChange()
      }}
      onReopen={() => {
        hook.reopenThread(cellId, thread.id)
        handleChange()
      }}
    />
  )
}
