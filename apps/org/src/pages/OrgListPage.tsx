// Org list — the user's orgs + entry to active-org management.
//
// `fetchUserOrgs` currently returns the caller's *single* org (the server
// auto-creates one if none exists). When the data model gets multi-org
// support, the page lists every org and you click in to manage. Until
// then we render the single org with quick actions.

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { fetchUserOrgs, type MyOrg } from "@aquilla/api-client"
import { getJwt, redirectToLogin } from "@aquilla/auth-client"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

export function OrgListPage() {
  const [org, setOrg] = useState<MyOrg | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const jwt = getJwt()
    if (!jwt) {
      redirectToLogin()
      return
    }
    let cancelled = false
    fetchUserOrgs(jwt)
      .then((data) => {
        if (!cancelled) setOrg(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message ?? "Failed to load org")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Organization</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage org-wide membership across all projects you have admin rights on.
      </p>

      {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <div className="mt-4 rounded border bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {org && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{org.name ?? "Your organization"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              You&rsquo;re an org <strong>{org.role.name}</strong>.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => navigate("/members")}>Members</Button>
              <Button variant="outline" onClick={() => navigate("/invite")}>
                Invite to multiple projects
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
