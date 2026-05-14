// Org members list.
//
// First-version surface: shows everyone in the caller's personal org with
// their role, plus a "remove" action for owners. The cross-project members
// matrix from src/pages/MembersPage.tsx (~500 lines) is deferred until the
// matrix hooks are extracted into shared packages.
//
// Server endpoints used:
//   GET    /api/v2/orgs/me                         (caller's org)
//   GET    /api/v2/orgs/:orgId/members             (members list)
//   DELETE /api/v2/orgs/:orgId/members/:userId     (remove member; owner-only)

import { useEffect, useState, useCallback } from "react"
import { Link } from "react-router-dom"
import {
  fetchUserOrgs,
  fetchOrgMembers,
  removeOrgMember,
  type MyOrg,
  type OrgMember,
} from "@aquilla/api-client"
import {
  getJwt,
  redirectToLogin,
  handleAuthExpiredAndRedirect,
} from "@aquilla/auth-client"
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@aquilla/ui"

export function MembersPage() {
  const [org, setOrg] = useState<MyOrg | null>(null)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)

  const handleAuthError = useCallback((err: unknown): boolean => {
    if (err && typeof err === "object" && (err as { status?: number }).status === 401) {
      handleAuthExpiredAndRedirect()
      return true
    }
    return false
  }, [])

  useEffect(() => {
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    let cancelled = false
    fetchUserOrgs(jwt)
      .then(async (o) => {
        if (cancelled) return
        setOrg(o)
        const ms = await fetchOrgMembers(o.id, jwt)
        if (!cancelled) setMembers(ms)
      })
      .catch((err) => {
        if (cancelled) return
        if (handleAuthError(err)) return
        setError(err.message ?? "Failed to load members")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [handleAuthError])

  async function handleRemove(userId: number): Promise<void> {
    if (!org || pendingRemove != null) return
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    setPendingRemove(userId)
    setError(null)
    try {
      await removeOrgMember(org.id, userId, jwt)
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
      setConfirmRemove(null)
    } catch (err) {
      if (handleAuthError(err)) return
      setError(err instanceof Error ? err.message : "Couldn't remove member")
    } finally {
      setPendingRemove(null)
    }
  }

  const isOwner = org?.role.level === 700

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4">
        <Link to="/">
          <Button variant="ghost" size="sm">
            ← Organization
          </Button>
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">Members</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everyone with access to {org?.name ?? "your organization"}.
      </p>

      {loading && (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <Alert tone="error" className="mt-4" role="alert">
          {error}
        </Alert>
      )}

      {org && members.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{org.name ?? "Org"} members</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center justify-between gap-2 py-3 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{m.username}</span>
                    <span className="text-xs text-muted-foreground">
                      {m.role.name}
                      {m.lastActiveAt && (
                        <> · last active {formatRelativeTime(m.lastActiveAt)}</>
                      )}
                    </span>
                  </div>
                  {isOwner && m.role.level !== 700 && (
                    <div className="flex items-center gap-2">
                      {confirmRemove === m.userId ? (
                        <>
                          <span className="text-xs text-muted-foreground">
                            Remove?
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRemove(m.userId)}
                            disabled={pendingRemove === m.userId}
                          >
                            {pendingRemove === m.userId ? "Removing…" : "Yes"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmRemove(null)}
                            disabled={pendingRemove === m.userId}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRemove(m.userId)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {!loading && org && members.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          No members yet.
        </p>
      )}
    </div>
  )
}

/** Tiny relative-time formatter — avoids pulling in date-fns for one
 *  string. "5m ago", "3d ago", "2026-04-12" past 30 days. */
function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const diffSec = Math.max(0, (Date.now() - then) / 1000)
  if (diffSec < 60) return "just now"
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 30 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`
  return iso.slice(0, 10)
}
