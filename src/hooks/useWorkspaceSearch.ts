import { useCallback, useMemo, useRef, useState } from "react"
import { WorkspaceIndex, type WorkspaceSearchResult } from "@/lib/search/workspace-index"
import { collectExportCells } from "@/lib/store/file-doc"
import type { FileReference } from "@/lib/parsers/types"

export function useWorkspaceSearch(files: FileReference[]) {
  const indexRef = useRef(new WorkspaceIndex())
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])

  const filesKey = useMemo(() => files.map((f) => f.id).join(","), [files])
  const lastBuiltKey = useRef<string>("")

  // Invalidate if files list changes
  if (lastBuiltKey.current !== "" && lastBuiltKey.current !== filesKey && ready) {
    setReady(false)
  }

  const buildIndex = useCallback(async () => {
    if (lastBuiltKey.current === filesKey && ready) return
    setLoading(true)
    try {
      const fileDatas = await Promise.all(
        files.map(async (f) => {
          const data = await collectExportCells(f.id)
          return { fileId: f.id, fileName: data.fileName, cells: data.cells }
        })
      )
      indexRef.current.buildFromProject(fileDatas)
      lastBuiltKey.current = filesKey
      setReady(true)
    } finally {
      setLoading(false)
    }
  }, [files, filesKey, ready])

  const search = useCallback((query: string, options: { fileId?: string; limit?: number } = {}) => {
    setResults(indexRef.current.search(query, options.limit ?? 20, { fileId: options.fileId }))
  }, [])

  const rebuild = useCallback(() => {
    lastBuiltKey.current = ""
    setReady(false)
    return buildIndex()
  }, [buildIndex])

  return { buildIndex, rebuild, search, results, loading, ready }
}
