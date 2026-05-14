// Members matrix — the discrete-app port of src/pages/MembersPage.tsx
// (+ MembersMatrixView + MembersMatrixCellEditor + RemoveOrgMemberDialog).
//
// Phase 3c stub. The matrix UI (~500 lines plus child components) depends on
// useOrg, useProjectsMembersMatrix, and useProjectMembers hooks that live
// in src/hooks/. Those hooks read from auth-worker via @aquilla/api-client
// + role-resolution helpers; relocating them is Phase 3a's domain. Once
// that lands, this page is a one-to-one port.

import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  fetchUserOrgs,
  fetchOrgMembers,
  type MyOrg,
  type OrgMember,
} from "@aquilla/api-client"
import { getJwt, redirectToLogin } from "@aquilla/auth-client"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

export function MembersPage() {
  const [org, setOrg] = useState<MyOrg | null>(null)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        if (!cancelled) setError(err.message ?? "Failed to load members")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
        Phase 3c scaffold. The full members matrix (assign roles per
        project, bulk invite, remove) ports from src/pages/MembersPage.tsx
        once Phase 3a relocates the matrix hooks.
      </p>

      {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <div className="mt-4 rounded border bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
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
                  className="flex items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="font-medium">{m.username}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.role.name}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
