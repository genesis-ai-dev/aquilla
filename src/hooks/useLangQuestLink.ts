// A project's LangQuest link (AQU-2105): its state, and the sync that keeps
// the project following the linked language.
//
// The sync runs on open, when the window regains focus (at most every
// AUTO_SYNC_EVERY_MS), and on "Sync now" — only for someone who may write
// source cells (project lead+), since that is what an import is. A brand-new
// link has no cursor yet, so its first run is the whole import. One run at a
// time per mounted project.

import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { bulkUploadSource } from "@/lib/sync/bulk-import"
import { bulkPostEvents } from "@/lib/sync/bulk-events"
import { ROLE } from "@/lib/sync/role-policy"
import { uploadCellAudio } from "@/lib/audio/upload"
import {
  fetchLangQuestAudio,
  fetchLangQuestChanges,
  fetchLangQuestLink,
  fetchLangQuestPassages,
  fetchLangQuestState,
  saveLangQuestState,
} from "@/lib/langquest/api"
import { syncLangQuest, type LangQuestSyncProgress, type LangQuestSyncResult } from "@/lib/langquest/sync"
import type { LangQuestLink } from "@/lib/langquest/types"
import posthog from "@/lib/posthog"

const AUTO_SYNC_EVERY_MS = 2 * 60 * 1000

export type LangQuestSyncState =
  | { kind: "idle" }
  | { kind: "running"; progress: LangQuestSyncProgress | null }
  | { kind: "done"; result: LangQuestSyncResult }
  | { kind: "failed"; message: string }

export function useLangQuestLink(projectId: string, roleLevel: number | null, onSynced?: () => void) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const author = session?.username ?? "local"
  const [link, setLink] = useState<LangQuestLink | null>(null)
  const [sync, setSync] = useState<LangQuestSyncState>({ kind: "idle" })
  const running = useRef(false)
  // Held in a ref so a host passing an inline callback does not restart the sync effect.
  const onSyncedRef = useRef(onSynced)
  useEffect(() => {
    onSyncedRef.current = onSynced
  })
  const lastRun = useRef(0)
  const canSync = (roleLevel ?? 0) >= ROLE.PROJECT_LEAD


  const reload = useCallback(async () => {
    if (!jwt) return null
    try {
      const next = await fetchLangQuestLink(jwt, projectId)
      setLink(next)
      return next
    } catch (err) {
      // Not linked, or the identity worker is unreachable: the badge simply hides.
      console.warn("[langquest] link read failed:", err)
      setLink(null)
      return null
    }
  }, [jwt, projectId])

  const syncLink = useCallback(
    async (link: LangQuestLink | null, trigger: "open" | "focus" | "manual") => {
      if (!jwt || !link || !canSync || link.needsReauth || running.current) return
      running.current = true
      lastRun.current = Date.now()
      // Built per run, not per render: an unlinked project never needs upload tokens.
      const getToken = buildFileScopedTokenFetcher(() => jwt, projectId, {}, FRONTIER_API_URL)
      setSync({ kind: "running", progress: null })
      const started = performance.now()
      try {
        const result = await syncLangQuest({
          projectId,
          languageId: link.language.id,
          author,
          targetLang: link.language.code,
          fetchState: () => fetchLangQuestState(jwt, projectId),
          saveState: (body) => saveLangQuestState(jwt, projectId, body),
          fetchChanges: (after) => fetchLangQuestChanges(jwt, projectId, after),
          fetchPassages: (opts) => fetchLangQuestPassages(jwt, projectId, opts),
          fetchAudio: (url) => fetchLangQuestAudio(jwt, projectId, url),
          uploadSource: bulkUploadSource,
          postEvents: bulkPostEvents,
          uploadAudio: uploadCellAudio,
          getToken,
          onProgress: (progress) => setSync({ kind: "running", progress }),
        })
        setSync({ kind: "done", result })
        if (result.cellsCreated + result.takesAttached + result.cellsRemoved > 0) onSyncedRef.current?.()
        posthog.capture("langquest synced", {
          project_id: projectId,
          trigger,
          mode: result.mode,
          passages_read: result.passagesRead,
          cells_created: result.cellsCreated,
          takes_attached: result.takesAttached,
          cells_removed: result.cellsRemoved,
          duration_ms: Math.round(performance.now() - started),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setSync({ kind: "failed", message })
        posthog.capture("langquest sync failed", { project_id: projectId, trigger, error: message.slice(0, 200) })
      } finally {
        running.current = false
        await reload()
      }
    },
    [jwt, canSync, projectId, author, reload],
  )

  const runSync = useCallback((trigger: "focus" | "manual") => syncLink(link, trigger), [syncLink, link])

  // Read the link; on first sight of a usable one, sync (a new link's whole
  // import starts here). Re-runs when the role resolves, so a lead whose role
  // arrives after mount still starts the sync.
  useEffect(() => {
    let cancelled = false
    if (!jwt) return
    void fetchLangQuestLink(jwt, projectId)
      .then((next) => {
        if (cancelled) return
        setLink(next)
        void syncLink(next, "open")
      })
      .catch(() => {
        if (!cancelled) setLink(null)
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, syncLink])

  const linked = !!link && !link.needsReauth
  useEffect(() => {
    if (!linked || !canSync) return
    const onFocus = () => {
      if (Date.now() - lastRun.current >= AUTO_SYNC_EVERY_MS) void runSync("focus")
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [linked, canSync, runSync])

  return { link, sync, canSync, runSync, reload, jwt }
}
