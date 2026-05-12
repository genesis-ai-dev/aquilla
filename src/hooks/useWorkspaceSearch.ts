import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  WorkspaceIndex,
  type SearchOptions,
  type WorkspaceSearchResult,
} from "@/lib/search/workspace-index"
import { collectExportCells } from "@/lib/store/file-doc"
import type { FileReference } from "@/lib/parsers/types"

/**
 * Loads project cells into a substring index. The index rebuilds when the
 * file list changes; callers can also `rebuild()` after edits (e.g. replace).
 */
export function useWorkspaceSearch(files: FileReference[]) {
  const indexRef = useRef(new WorkspaceIndex())
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])

  const filesKey = useMemo(() => files.map((f) => f.id).join(","), [files])
  const builtKey = useRef<string>("")

  // Drop ready when the file list changes — next buildIndex() will reload.
  useEffect(() => {
    if (builtKey.current && builtKey.current !== filesKey) {
      setReady(false)
      builtKey.current = ""
    }
  }, [filesKey])

  const buildIndex = useCallback(async () => {
    if (builtKey.current === filesKey) return
    setLoading(true)
    try {
      const fileDatas = await Promise.all(files.map(async (f) => {
        const data = await collectExportCells(f.id)
        return { fileId: f.id, fileName: data.fileName, cells: data.cells }
      }))
      indexRef.current.buildFromProject(fileDatas)
      builtKey.current = filesKey
      setReady(true)
    } finally {
      setLoading(false)
    }
  }, [files, filesKey])

  const search = useCallback((query: string, options: SearchOptions = {}) => {
    setResults(indexRef.current.search(query, options))
  }, [])

  const clear = useCallback(() => setResults([]), [])

  const rebuild = useCallback(() => {
    builtKey.current = ""
    setReady(false)
    return buildIndex()
  }, [buildIndex])

  return { buildIndex, rebuild, search, clear, results, loading, ready }
}
