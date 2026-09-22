// AQU-462: original-language morphology for one cell, fetched on demand.
//
// Same shape as useCellValidators (vanilla useState + race-guarded effect, no
// React Query — AD-3). `enabled` is doing real work here: a Macula book carries
// tens of thousands of morph rows, so this must fire when the translator opens
// the alignment view for a row, not while a file's worth of rows renders.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchCellMorph, type MorphWord } from "@/lib/sync/morph-read"

export interface UseCellMorphOptions {
  enabled: boolean
  projectId: string | null
  fileId: string | null
  cellId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
}

export interface UseCellMorphResult {
  /** Words in `wordSeq` order; empty when the cell has no morphology. */
  words: MorphWord[]
  isLoading: boolean
  isError: boolean
}

export function useCellMorph(opts: UseCellMorphOptions): UseCellMorphResult {
  const { enabled, projectId, fileId, cellId, getTokenForFile } = opts

  const [words, setWords] = useState<MorphWord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const fileRef = useRef(fileId)
  const cellRef = useRef(cellId)
  const tokenRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const generationRef = useRef(0)

  projectRef.current = projectId
  fileRef.current = fileId
  cellRef.current = cellId
  tokenRef.current = getTokenForFile
  enabledRef.current = enabled

  const doFetch = useCallback(async () => {
    const pid = projectRef.current
    const fid = fileRef.current
    const cid = cellRef.current
    if (!enabledRef.current || !pid || !fid || !cid) {
      // Drop stale words on disable so a collapsed panel cannot reopen showing
      // the previous cell's original-language words.
      setWords([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = await tokenRef.current(fid)
      if (generationRef.current !== gen) return
      if (!token) {
        setIsError(true)
        setIsLoading(false)
        return
      }
      const rows = await fetchCellMorph({
        projectId: pid,
        fileId: fid,
        cellIds: [cid],
        jwt: token,
      })
      if (generationRef.current !== gen) return
      setWords(rows)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellMorph] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fileId, cellId, enabled])

  return { words, isLoading, isError }
}
