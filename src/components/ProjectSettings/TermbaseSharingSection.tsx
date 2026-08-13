import { useCallback, useEffect, useRef, useState } from "react"
import { GripVertical, Trash2, Plus } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  publishTermbase,
  unpublishTermbase,
  listPublishedTermbases,
  listSubscriptions,
  subscribeTermbase,
  unsubscribeTermbase,
  reorderSubscriptions,
  TermbaseApiError,
  type PublishedTermbase,
  type TermbaseSubscription,
} from "@/lib/terminology/subscriptions-api"

interface Props {
  projectId: string
  /** The org this project belongs to, or null if not org-owned. */
  orgId: number | null
  /**
   * The caller's resolved role level on this project (AD-12 max-wins).
   * Publish/subscribe mutations require maintainer (600+); mirrors how other
   * sections gate on syncRole.level.
   */
  roleLevel: number | null
}

const MAINTAINER = 600

function errMsg(e: unknown): string {
  if (e instanceof TermbaseApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * =============================================================================
 * HIDDEN FROM SETTINGS UI — see SHOW_TERMBASE_SHARING_IN_SETTINGS in
 * ProjectSettings.tsx (false since 2026-06-11). Component + API remain; not
 * mounted until that flag is flipped back to true.
 * =============================================================================
 *
 * Project Settings section for org termbase publish/subscribe (spec Slices 6-7,
 * aquilla terminology.md §"Termbase — sharing across projects").
 *
 * - Publish toggle: publish THIS project's termbase to its org (maintainer
 *   600+, org-owned only).
 * - Subscriptions: subscribe to other published termbases in the org, with
 *   unsubscribe and drag-to-reorder priority (index 0 = highest precedence).
 *
 * Subscribed concepts feed enforcement via useSubscribedConcepts → useRules;
 * this component manages the subscription rows only.
 */
export function TermbaseSharingSection({ projectId, orgId, roleLevel }: Props) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const canManage = (roleLevel ?? 0) >= MAINTAINER && orgId != null
  const isOrgOwned = orgId != null

  const [published, setPublished] = useState(false)
  const [orgTermbases, setOrgTermbases] = useState<PublishedTermbase[]>([])
  const [subscriptions, setSubscriptions] = useState<TermbaseSubscription[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)
  const dragIndex = useRef<number | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!jwt || !isOrgOwned || orgId == null) return
    setLoading(true)
    setError(null)
    try {
      const [subs, term] = await Promise.all([
        listSubscriptions(jwt, projectId),
        listPublishedTermbases(jwt, orgId),
      ])
      if (!aliveRef.current) return
      setSubscriptions(subs)
      setOrgTermbases(term)
      // Whether THIS project is published is reflected in the org listing.
      setPublished(term.some((t) => t.projectId === projectId))
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, orgId, isOrgOwned, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const togglePublish = useCallback(
    async (next: boolean) => {
      if (!jwt || !canManage) return
      setBusy(true)
      setError(null)
      try {
        if (next) await publishTermbase(jwt, projectId)
        else await unpublishTermbase(jwt, projectId)
        setPublished(next)
        await load()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    },
    [jwt, canManage, projectId, load],
  )

  const subscribe = useCallback(
    async (termbaseProjectId: string) => {
      if (!jwt || !canManage) return
      setBusy(true)
      setError(null)
      try {
        await subscribeTermbase(jwt, projectId, termbaseProjectId)
        await load()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    },
    [jwt, canManage, projectId, load],
  )

  const unsubscribe = useCallback(
    async (termbaseProjectId: string) => {
      if (!jwt || !canManage) return
      setBusy(true)
      setError(null)
      try {
        await unsubscribeTermbase(jwt, projectId, termbaseProjectId)
        await load()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(false)
      }
    },
    [jwt, canManage, projectId, load],
  )

  const persistOrder = useCallback(
    async (ordered: TermbaseSubscription[]) => {
      if (!jwt || !canManage) return
      setBusy(true)
      setError(null)
      try {
        const next = await reorderSubscriptions(
          jwt,
          projectId,
          ordered.map((s) => s.termbaseProjectId),
        )
        if (aliveRef.current) setSubscriptions(next)
      } catch (e) {
        setError(errMsg(e))
        await load() // re-sync on failure
      } finally {
        setBusy(false)
      }
    },
    [jwt, canManage, projectId, load],
  )

  function onDragStart(i: number) {
    dragIndex.current = i
  }
  function onDrop(target: number) {
    const from = dragIndex.current
    dragIndex.current = null
    if (from == null || from === target) return
    const next = [...subscriptions]
    const [moved] = next.splice(from, 1)
    next.splice(target, 0, moved)
    setSubscriptions(next) // optimistic
    void persistOrder(next)
  }

  // Termbases available to subscribe to: published in the org, not this
  // project, not already subscribed.
  const subscribedIds = new Set(subscriptions.map((s) => s.termbaseProjectId))
  const available = orgTermbases.filter(
    (t) => t.projectId !== projectId && !subscribedIds.has(t.projectId),
  )

  if (!isOrgOwned) {
    return (
      <Card id="section-termbase-sharing">
        <CardHeader>
          <CardTitle>Term Base Sharing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Term base sharing is available for org-owned projects only. Move this
            project into an organization to publish or subscribe to shared
            term bases.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card id="section-termbase-sharing">
      <CardHeader>
        <CardTitle>Termbase Sharing</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && (
          <div
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {/* Publish toggle */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Publish this term base to the org</p>
            <p className="text-sm text-muted-foreground">
              Lets other projects in your organization subscribe to this
              project&apos;s approved terms.
            </p>
          </div>
          <Switch
            checked={published}
            onCheckedChange={togglePublish}
            disabled={!canManage || busy || loading}
            aria-label="Publish term base to org"
          />
        </div>

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Maintainer (or higher) on an org-owned project is required to manage
            term base sharing.
          </p>
        )}

        {/* Current subscriptions */}
        <div>
          <p className="mb-2 text-sm font-medium">
            Subscribed term bases{" "}
            <span className="font-normal text-muted-foreground">
              (drag to set priority — top = highest precedence)
            </span>
          </p>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading subscriptions…</p>
          ) : subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not subscribed to any term bases yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {subscriptions.map((s, i) => (
                <li
                  key={s.termbaseProjectId}
                  draggable={canManage && !busy}
                  onDragStart={() => onDragStart(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(i)}
                  className="flex items-center gap-2 rounded border bg-card px-2 py-1.5 text-sm"
                >
                  {canManage && (
                    <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate">{s.termbaseName}</span>
                  {!s.published && (
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">
                      upstream unpublished
                    </Badge>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    #{i + 1}
                  </span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      disabled={busy}
                      onClick={() => unsubscribe(s.termbaseProjectId)}
                      aria-label={`Unsubscribe from ${s.termbaseName}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Available to subscribe */}
        {canManage && (
          <div>
            <p className="mb-2 text-sm font-medium">Available in your org</p>
            {loading ? (
              <div className="flex items-center text-muted-foreground">
                <Spinner className="size-4" />
              </div>
            ) : available.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No other published term bases in your organization.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {available.map((t) => (
                  <li
                    key={t.projectId}
                    className="flex items-center gap-2 rounded border bg-card px-2 py-1.5 text-sm"
                  >
                    <span className="flex-1 truncate">{t.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      by {t.createdBy}
                    </span>
                    <Button
                      variant="outline"
                      className="shrink-0"
                      disabled={busy}
                      onClick={() => subscribe(t.projectId)}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Subscribe
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
