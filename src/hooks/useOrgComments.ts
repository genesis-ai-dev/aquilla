/**
 * useOrgComments — comments across every project of an org the caller can see.
 *
 * AQU-1958. There is no org-level comments endpoint and this hook does not
 * pretend there is one: it reads the org's project list (server-filtered to the
 * caller's access) and then calls each project's existing comments read with a
 * token scoped to that project. Both calls are already authorized server-side,
 * so a project the viewer lacks contributes nothing — it is absent from the
 * list, and a sync-token for it would be refused.
 *
 * Partial failure is reported, never hidden: one project that 403s or times out
 * leaves the other projects' comments on screen and names itself in
 * `failedProjects`, because a silently short list reads as "no feedback this
 * week" to the person reviewing it.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchAccessibleProjectsResult } from "@/lib/sync/cloud-projects"
import { fetchCommentsForProject } from "@/lib/sync/comments-read"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { projectsResultError } from "@/lib/sync/cloud-projects"
import { toUserFacingError } from "@/lib/errors/user-error"
import type { OrgCommentsProject } from "@/lib/comments/org-comments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

export interface UseOrgCommentsOptions {
  /** Org to read. Null (no active member org, or below the role floor) loads nothing. */
  orgId: number | null
  /** Session JWT; null until the session loads. */
  jwt: string | null
}

export interface UseOrgComments {
  comments: CommentRecord[]
  projects: OrgCommentsProject[]
  isLoading: boolean
  /** Display names of projects whose comments could not be read this pass. */
  failedProjects: string[]
  /** Set only when the project list itself failed — nothing could be loaded. */
  error: string | null
  refresh: () => Promise<void>
}

/**
 * How many projects' comments are read at once. BGP's editorial leads see
 * dozens of projects; firing every read in one burst would queue them behind
 * each other in the browser anyway and spike the worker, while one-at-a-time
 * makes a 30-project org feel broken.
 */
const PROJECT_FETCH_CONCURRENCY = 4

/** Any fileId works — a project-level read verifies the token's projectId only. */
const TOKEN_FILE_SCOPE = "any"

export function useOrgComments({ orgId, jwt }: UseOrgCommentsOptions): UseOrgComments {
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [projects, setProjects] = useState<OrgCommentsProject[]>([])
  const [failedProjects, setFailedProjects] = useState<string[]>([])
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const requestRef = useRef(0)

  // Reset on each effect run — a cleanup-only flip would stay false forever
  // under StrictMode's double-mount (same rationale as useAccessibleProjects).
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    const isCurrent = () => aliveRef.current && requestRef.current === request
    if (orgId == null || !jwt) {
      setComments([])
      setProjects([])
      setFailedProjects([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const listed = await fetchAccessibleProjectsResult(jwt, orgId)
      if (!listed.ok) {
        if (listed.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
        throw projectsResultError(listed)
      }
      if (!isCurrent()) return
      const orgProjects: OrgCommentsProject[] = listed.projects
        .map((project) => ({
          id: project.id,
          name: project.name,
          files: (project.files ?? []).map((file) => ({ id: file.id, name: file.name })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setProjects(orgProjects)
      setComments([])
      setFailedProjects([])

      const collected: CommentRecord[] = []
      const failed: string[] = []
      for (let i = 0; i < orgProjects.length; i += PROJECT_FETCH_CONCURRENCY) {
        if (!isCurrent()) return
        const batch = orgProjects.slice(i, i + PROJECT_FETCH_CONCURRENCY)
        const results = await Promise.all(batch.map(async (project) => {
          try {
            const getToken = buildFileScopedTokenFetcher(() => jwt, project.id)
            const token = await getToken(TOKEN_FILE_SCOPE)
            if (!token) return { project, rows: null }
            return { project, rows: await fetchCommentsForProject(project.id, token) }
          } catch (caught) {
            console.warn(`[useOrgComments] ${project.id} failed:`, caught)
            return { project, rows: null }
          }
        }))
        if (!isCurrent()) return
        for (const result of results) {
          if (result.rows === null) failed.push(result.project.name)
          else collected.push(...result.rows)
        }
        // Publish each batch as it lands so the first projects render while the
        // rest are still in flight.
        setComments([...collected])
        setFailedProjects([...failed])
      }
    } catch (caught) {
      if (!isCurrent()) return
      setComments([])
      setProjects([])
      setFailedProjects([])
      setError(toUserFacingError(caught, "project").message)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [orgId, jwt])

  useEffect(() => { void refresh() }, [refresh])

  return { comments, projects, isLoading, failedProjects, error, refresh }
}
