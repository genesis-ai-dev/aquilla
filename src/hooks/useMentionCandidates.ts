import { useEffect, useMemo, useState } from "react"
import { fetchMentionCandidates, type ProjectMember } from "@/lib/frontier/members"
import type { MentionCandidate } from "@/lib/comments/mention-suggest"
import { useFrontierSession } from "./useFrontierSession"

export interface UseMentionCandidates {
  /** People the comment composer may offer for @mention. */
  candidates: readonly MentionCandidate[]
  /**
   * True when the org hides the roster from this caller, so `candidates` is
   * the lane-scoped subset the server returns rather than the full roster.
   * The composer uses it to say "no one in your lanes" instead of "no one on
   * this project" when the list is empty.
   */
  restricted: boolean
}

const EMPTY: readonly MentionCandidate[] = []

/**
 * AQU-1815: mention candidates for the comment composer.
 *
 * The roster (`useProjectMembers`) is the list whenever the caller may read
 * it, so a Project Lead and above pays no extra request. Below the org's
 * roster floor the roster read 403s and the hook asks the mention-candidates
 * endpoint instead, which names the caller's lane-mates plus Maintainer and
 * above (`auth-worker` services/mention-candidates.ts). Until that answer
 * lands the list is empty but already flagged `restricted`, so the composer
 * never shows "No one on this project" to a Contributor.
 */
export function useMentionCandidates(
  projectId: string | null,
  roster: { members: readonly ProjectMember[]; rosterHidden: boolean },
): UseMentionCandidates {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const { members, rosterHidden } = roster
  const [scoped, setScoped] = useState<{ projectId: string; candidates: MentionCandidate[] } | null>(null)

  useEffect(() => {
    if (!jwt || !projectId || !rosterHidden) return
    let alive = true
    void fetchMentionCandidates(jwt, projectId)
      .then((result) => {
        if (alive) setScoped({ projectId, candidates: result.candidates })
      })
      .catch((err: unknown) => {
        // The composer's restricted empty state explains the gap; a failed
        // read must not take the comments drawer down with it.
        console.warn("[AQU-1815] mention candidates unavailable", err)
      })
    return () => {
      alive = false
    }
  }, [jwt, projectId, rosterHidden])

  const fromRoster = useMemo(() => members.map((m) => ({ username: m.username })), [members])

  if (!rosterHidden) return { candidates: fromRoster, restricted: false }
  const candidates = scoped && scoped.projectId === projectId ? scoped.candidates : EMPTY
  return { candidates, restricted: true }
}
