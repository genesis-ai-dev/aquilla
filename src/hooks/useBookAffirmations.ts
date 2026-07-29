/**
 * useBookAffirmations — project book-done affirmations (AQU-727).
 *
 * A thin AD-3 read (the project's book_affirmations) plus two deliberate
 * writes (affirm / withdraw). Affirming is a low-frequency Project Lead action
 * on the project-overview page, so — like assignments — the writes POST the
 * event to the sync-worker directly (not via the outbox) and await acceptance;
 * on success we optimistically update the local map and revalidate.
 *
 * Plain useState + race-guarded effect (no React-Query hooks — CLAUDE.md rule).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  fetchBookAffirmations,
  affirmBook,
  unaffirmBook,
  type BookAffirmation,
} from "@/lib/sync/book-affirmations"

export interface UseBookAffirmationsOptions {
  projectId: string | null
  jwt: string | null
  /** Current username — stamped as `author` on emitted events (server re-verifies). */
  author: string
  projectName?: string
  /**
   * Any file-scoped sync-token minter for this project — reads only verify the
   * projectId from the JWT, so any file works. Returns null when unavailable
   * (e.g. no session yet); the load waits rather than erroring.
   */
  getToken?: () => Promise<string | null>
}

export interface UseBookAffirmationsApi {
  /** Affirmations keyed by bookCode for O(1) lookup from a book row. */
  affirmations: Map<string, BookAffirmation>
  isLoading: boolean
  isError: boolean
  /** Affirm a book done. `fileId` is a representative file for routing/auth. */
  affirm: (bookCode: string, fileId: string, note?: string | null) => Promise<void>
  /** Withdraw a book's affirmation. */
  unaffirm: (bookCode: string, fileId: string) => Promise<void>
  refresh: () => Promise<void>
}

export function useBookAffirmations(opts: UseBookAffirmationsOptions): UseBookAffirmationsApi {
  const { projectId, jwt, author, projectName, getToken } = opts

  const [affirmations, setAffirmations] = useState<Map<string, BookAffirmation>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const projectRef = useRef(projectId)
  const jwtRef = useRef(jwt)
  const authorRef = useRef(author)
  const projectNameRef = useRef(projectName)
  const tokenRef = useRef(getToken)
  useEffect(() => {
    projectRef.current = projectId
    jwtRef.current = jwt
    authorRef.current = author
    projectNameRef.current = projectName
    tokenRef.current = getToken
  }, [projectId, jwt, author, projectName, getToken])

  const refresh = useCallback(async () => {
    const pid = projectRef.current
    const mintToken = tokenRef.current
    if (!pid || !mintToken) return
    setIsLoading(true)
    setIsError(false)
    try {
      const token = await mintToken()
      if (!token) {
        setIsLoading(false)
        return
      }
      const rows = await fetchBookAffirmations(pid, token)
      setAffirmations(new Map(rows.map((r) => [r.bookCode, r])))
    } catch (err) {
      console.warn("[useBookAffirmations] fetch failed:", err)
      setIsError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    refresh().catch(() => {/* refresh sets isError */})
  }, [projectId, refresh])

  const affirm = useCallback(async (bookCode: string, fileId: string, note?: string | null) => {
    const pid = projectRef.current
    const j = jwtRef.current
    if (!pid || !j) return
    await affirmBook({
      jwt: j,
      projectId: pid,
      fileId,
      bookCode,
      author: authorRef.current,
      note: note ?? null,
      projectName: projectNameRef.current,
    })
    // Optimistic: reflect the affirmation immediately, then revalidate.
    setAffirmations((prev) => {
      const next = new Map(prev)
      next.set(bookCode, {
        projectId: pid,
        bookCode,
        affirmedBy: 0,
        affirmedByLabel: authorRef.current,
        eventId: "",
        affirmedAt: Date.now(),
        note: note ?? null,
      })
      return next
    })
    await refresh()
  }, [refresh])

  const unaffirm = useCallback(async (bookCode: string, fileId: string) => {
    const pid = projectRef.current
    const j = jwtRef.current
    if (!pid || !j) return
    await unaffirmBook({
      jwt: j,
      projectId: pid,
      fileId,
      bookCode,
      author: authorRef.current,
      projectName: projectNameRef.current,
    })
    setAffirmations((prev) => {
      const next = new Map(prev)
      next.delete(bookCode)
      return next
    })
    await refresh()
  }, [refresh])

  return { affirmations, isLoading, isError, affirm, unaffirm, refresh }
}
