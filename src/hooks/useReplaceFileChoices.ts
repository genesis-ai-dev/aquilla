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

import { useCallback, useRef, useState } from "react"
import { fetchLinkFileMatches, type LinkFileMatch } from "@/lib/sync/link-file-match"
import type { LinkSourcePreviewFile } from "@/lib/sync/link-source-preview"

/** Where the comparison of one file pair has got to. */
export type ReplaceMatchState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; match: LinkFileMatch }

export interface ReplaceFileChoices {
  /** The upstream file ids the lead has set to replace the project's own file. */
  replaceFileIds: ReadonlySet<string>
  /** The server's answer per upstream file id, once asked. */
  matches: ReadonlyMap<string, ReplaceMatchState>
  /** One row's option pressed. `replace: true` asks the server to compare. */
  toggleReplace: (upstreamFileId: string, replace: boolean) => void
  /** Forget every choice and answer (the list is about to change). */
  reset: () => void
  /**
   * Whether any of `upstreamFileIds` is a replace the server has not cleared —
   * still comparing, could not compare, or not the same material. The caller
   * holds its action back while this is true; the row says which it is.
   */
  isUnresolved: (upstreamFileIds: readonly string[]) => boolean
}

export function useReplaceFileChoices(args: {
  jwt: string | undefined
  projectId: string
  /** The upstream the files belong to; null while none is under review. */
  sourceProjectId: string | null
  /** The rows on screen — the pairing reads each row's `clashFileId`. */
  files: readonly LinkSourcePreviewFile[]
}): ReplaceFileChoices {
  const { jwt, projectId, sourceProjectId, files } = args
  const [replaceFileIds, setReplaceFileIds] = useState<Set<string>>(new Set())
  const [matches, setMatches] = useState<Map<string, ReplaceMatchState>>(new Map())
  // Which comparison is the current one per file: an answer that arrives after
  // the option was turned off and on again must not overwrite the newer ask.
  const ask = useRef(new Map<string, number>())

  const reset = useCallback(() => {
    setReplaceFileIds(new Set())
    setMatches(new Map())
    ask.current = new Map()
  }, [])

  const toggleReplace = useCallback(
    (upstreamFileId: string, replace: boolean) => {
      setReplaceFileIds((current) => {
        const next = new Set(current)
        if (replace) next.add(upstreamFileId)
        else next.delete(upstreamFileId)
        return next
      })
      const mine = (ask.current.get(upstreamFileId) ?? 0) + 1
      ask.current.set(upstreamFileId, mine)
      const fileId = files.find((f) => f.id === upstreamFileId)?.clashFileId
      if (!replace || !fileId || !sourceProjectId || !jwt) return
      const settle = (state: ReplaceMatchState) => {
        if (ask.current.get(upstreamFileId) !== mine) return
        setMatches((current) => new Map(current).set(upstreamFileId, state))
      }
      settle({ status: "loading" })
      void fetchLinkFileMatches(jwt, projectId, sourceProjectId, [{ upstreamFileId, fileId }])
        .then(([match]) => settle(match ? { status: "ready", match } : { status: "failed" }))
        .catch(() => settle({ status: "failed" }))
    },
    [files, sourceProjectId, jwt, projectId],
  )

  const isUnresolved = useCallback(
    (upstreamFileIds: readonly string[]) =>
      upstreamFileIds.some((id) => {
        const state = matches.get(id)
        return state?.status !== "ready" || !state.match.canReplace
      }),
    [matches],
  )

  return { replaceFileIds, matches, toggleReplace, reset, isUnresolved }
}
