// AQU-1679: the "replace the source in my existing file" choice, shared by the
// two places that offer it — the link flow's confirm step (LinkSourceFlow) and
// "Choose files" on an existing link (ChooseLinkedFilesDialog).
//
// Both list the upstream's files, flag the ones whose name a file here already
// uses, and let the lead turn a flagged row into a replace. Turning it on asks
// the server how the two files compare (`fetchLinkFileMatches`) and the answer
// decides whether the action may go ahead. That ask-and-settle logic, with its
// guard against a stale answer, is what lives here, so the two surfaces cannot
// drift on it. What each surface SAYS about the answer stays with the surface.

// AQU-2549: the lead picks WHICH of his files a row replaces, from the
// project's file list, instead of the option existing only for an exact name
// match (a renamed file could never be replaced). A row whose name matches
// exactly one file starts ticked, with that file chosen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchLinkFileMatches, type LinkFileMatch } from "@/lib/sync/link-file-match"
import type { LinkSourceOwnFile, LinkSourcePreviewFile } from "@/lib/sync/link-source-preview"

/** Where the comparison of one file pair has got to. */
export type ReplaceMatchState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; match: LinkFileMatch }

export interface ReplaceFileChoices {
  /** The upstream file ids the lead has set to replace one of the project's files. */
  replaceFileIds: ReadonlySet<string>
  /** The server's answer per upstream file id, for the file now chosen. */
  matches: ReadonlyMap<string, ReplaceMatchState>
  /** One row's option pressed. `replace: true` asks the server to compare. */
  toggleReplace: (upstreamFileId: string, replace: boolean) => void
  /** AQU-2549: the project's file a row would replace, if one is chosen. */
  targetOf: (upstreamFileId: string) => string | undefined
  /** AQU-2549: the lead picked another of his files for a row. */
  chooseTarget: (upstreamFileId: string, fileId: string) => void
  /** AQU-2549: the upstream file ids among `upstreamFileIds` whose chosen file
   *  another of them has chosen too (one file can follow one upstream file). */
  takenTargets: (upstreamFileIds: readonly string[]) => ReadonlySet<string>
  /** AQU-2549: the project's files the lead can choose from. */
  ownFiles: readonly LinkSourceOwnFile[]
  /** Forget every choice and answer (the list is about to change). */
  reset: () => void
  /**
   * Whether any of `upstreamFileIds` is a replace the server has not cleared —
   * no file chosen, a file another row chose, still comparing, could not
   * compare, or not the same material. The caller holds its action back while
   * this is true; the row says which.
   */
  isUnresolved: (upstreamFileIds: readonly string[]) => boolean
}

type MatchEntry = { fileId: string; state: ReplaceMatchState }

export function useReplaceFileChoices(args: {
  jwt: string | undefined
  projectId: string
  /** The upstream the files belong to; null while none is under review. */
  sourceProjectId: string | null
  /** The rows on screen — a row's `clashFileId` is its default file. */
  files: readonly LinkSourcePreviewFile[]
  /** AQU-2549: the project's own files, to choose from. */
  ownFiles?: readonly LinkSourceOwnFile[]
  /** AQU-2549: the rows showing the option right now (checked, and a link
   *  that can replace). Only these are compared; a default on a row that is
   *  not showing it asks nothing. */
  offeredFileIds: ReadonlySet<string>
}): ReplaceFileChoices {
  const { jwt, projectId, sourceProjectId, files, offeredFileIds } = args
  const ownFiles = useMemo(() => args.ownFiles ?? [], [args.ownFiles])
  // The lead's presses; a row he has not touched follows its default (ticked
  // when exactly one file shares its name).
  const [pressed, setPressed] = useState<Map<string, boolean>>(new Map())
  const [chosen, setChosen] = useState<Map<string, string>>(new Map())
  const [entries, setEntries] = useState<Map<string, MatchEntry>>(new Map())
  // Which comparison is the current one per row: an answer that arrives after
  // the row changed must not overwrite the newer ask.
  const ask = useRef(new Map<string, number>())

  const replaceFileIds = useMemo(() => {
    const on = new Set<string>()
    for (const f of files) {
      if (pressed.get(f.id) ?? f.clashFileId !== undefined) on.add(f.id)
    }
    return on
  }, [files, pressed])

  const targetOf = useCallback(
    (upstreamFileId: string) =>
      chosen.get(upstreamFileId) ?? files.find((f) => f.id === upstreamFileId)?.clashFileId,
    [chosen, files],
  )

  // Ask the server about every ticked row whose chosen file it has not been
  // asked about — one request for the lot, so a 66-book default is one call.
  useEffect(() => {
    if (!sourceProjectId || !jwt) return
    const pairs: Array<{ upstreamFileId: string; fileId: string; mine: number }> = []
    for (const upstreamFileId of replaceFileIds) {
      if (!offeredFileIds.has(upstreamFileId)) continue
      const fileId = targetOf(upstreamFileId)
      if (!fileId || entries.get(upstreamFileId)?.fileId === fileId) continue
      const mine = (ask.current.get(upstreamFileId) ?? 0) + 1
      ask.current.set(upstreamFileId, mine)
      pairs.push({ upstreamFileId, fileId, mine })
    }
    if (pairs.length === 0) return
    const settle = (answers: Map<string, ReplaceMatchState>) =>
      setEntries((current) => {
        const next = new Map(current)
        for (const pair of pairs) {
          if (ask.current.get(pair.upstreamFileId) !== pair.mine) continue
          next.set(pair.upstreamFileId, { fileId: pair.fileId, state: answers.get(pair.upstreamFileId) ?? { status: "failed" } })
        }
        return next
      })
    settle(new Map(pairs.map((p) => [p.upstreamFileId, { status: "loading" } as const])))
    void Promise.resolve(
      fetchLinkFileMatches(
        jwt,
        projectId,
        sourceProjectId,
        pairs.map(({ upstreamFileId, fileId }) => ({ upstreamFileId, fileId })),
      ),
    )
      .then((answers) =>
        settle(new Map((answers ?? []).map((match) => [match.upstreamFileId, { status: "ready", match } as const]))),
      )
      .catch(() => settle(new Map()))
  }, [replaceFileIds, offeredFileIds, targetOf, entries, sourceProjectId, jwt, projectId])

  const matches = useMemo(() => {
    const out = new Map<string, ReplaceMatchState>()
    for (const [upstreamFileId, entry] of entries) {
      if (entry.fileId === targetOf(upstreamFileId)) out.set(upstreamFileId, entry.state)
    }
    return out
  }, [entries, targetOf])

  const reset = useCallback(() => {
    setPressed(new Map())
    setChosen(new Map())
    setEntries(new Map())
    ask.current = new Map()
  }, [])

  const toggleReplace = useCallback((upstreamFileId: string, replace: boolean) => {
    setPressed((current) => new Map(current).set(upstreamFileId, replace))
    // Off forgets the answer, so turning it on again asks afresh (the way out
    // of "couldn't compare").
    if (!replace) {
      ask.current.set(upstreamFileId, (ask.current.get(upstreamFileId) ?? 0) + 1)
      setEntries((current) => {
        if (!current.has(upstreamFileId)) return current
        const next = new Map(current)
        next.delete(upstreamFileId)
        return next
      })
    }
  }, [])

  const chooseTarget = useCallback((upstreamFileId: string, fileId: string) => {
    setChosen((current) => new Map(current).set(upstreamFileId, fileId))
  }, [])

  const takenTargets = useCallback(
    (upstreamFileIds: readonly string[]) => {
      const owners = new Map<string, string[]>()
      for (const id of upstreamFileIds) {
        const fileId = targetOf(id)
        if (fileId) owners.set(fileId, [...(owners.get(fileId) ?? []), id])
      }
      return new Set([...owners.values()].filter((ids) => ids.length > 1).flat())
    },
    [targetOf],
  )

  const isUnresolved = useCallback(
    (upstreamFileIds: readonly string[]) => {
      if (takenTargets(upstreamFileIds).size > 0) return true
      return upstreamFileIds.some((id) => {
        const state = matches.get(id)
        return state?.status !== "ready" || !state.match.canReplace
      })
    },
    [matches, takenTargets],
  )

  return {
    replaceFileIds,
    matches,
    toggleReplace,
    targetOf,
    chooseTarget,
    takenTargets,
    ownFiles,
    reset,
    isUnresolved,
  }
}
