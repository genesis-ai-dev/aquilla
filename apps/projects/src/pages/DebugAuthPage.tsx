// Diagnostic page for auth state. NOT linked from the UI — for support.
//
// Visit https://aquilla.app/projects/debug to see:
//   - all `aquilla_jwt` cookies the browser is holding (number, lengths)
//   - what getJwt() returns (which one wins)
//   - whether that JWT validates against /api/v2/projects
//   - a "Hard reset" button that wipes every variant + redirects to login
//
// When users report sign-in loops, point them here and the screenshot
// tells us exactly which (Path, Domain) variant is stuck.

import { useEffect, useState } from "react"
import { getJwt, clearJwt, redirectToLogin } from "@aquilla/auth-client"
import { fetchProjectList } from "@aquilla/api-client"
import { Button, Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

interface CookieRow {
  raw: string
  value: string
  length: number
}

function parseAquillaCookies(): CookieRow[] {
  if (typeof document === "undefined") return []
  const out: CookieRow[] = []
  for (const segment of (document.cookie || "").split(";")) {
    const eq = segment.indexOf("=")
    if (eq < 0) continue
    const key = segment.slice(0, eq).trim()
    if (key !== "aquilla_jwt") continue
    const valueRaw = segment.slice(eq + 1).trim()
    let value: string
    try {
      value = decodeURIComponent(valueRaw)
    } catch {
      value = valueRaw
    }
    out.push({ raw: segment.trim(), value, length: value.length })
  }
  return out
}

export function DebugAuthPage() {
  const [cookies, setCookies] = useState<CookieRow[]>(parseAquillaCookies())
  const [jwt, setJwt_] = useState<string | null>(getJwt())
  const [apiStatus, setApiStatus] = useState<string>("(not yet probed)")

  useEffect(() => {
    const j = getJwt()
    if (!j) {
      setApiStatus("no JWT to probe with")
      return
    }
    fetchProjectList(j)
      .then((list) =>
        setApiStatus(`✅ HTTP 200 — ${list.length} projects accessible`),
      )
      .catch((err) => {
        const status = (err as { status?: number }).status
        const msg = err instanceof Error ? err.message : String(err)
        setApiStatus(`❌ ${status ?? "?"} — ${msg}`)
      })
  }, [])

  function refresh(): void {
    setCookies(parseAquillaCookies())
    setJwt_(getJwt())
  }

  function hardReset(): void {
    clearJwt()
    refresh()
    setTimeout(() => redirectToLogin(), 100)
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 space-y-4">
      <h1 className="text-2xl font-semibold">Auth diagnostics</h1>
      <p className="text-sm text-muted-foreground">
        Use this page when sign-in loops or "401" errors won't go away.
        Screenshot the values and share with support.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Cookies named <code>aquilla_jwt</code></CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {cookies.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <>
              <p>
                Browser is holding <strong>{cookies.length}</strong> cookie
                {cookies.length === 1 ? "" : "s"} named <code>aquilla_jwt</code>.
              </p>
              <ul className="list-disc pl-5 space-y-1">
                {cookies.map((c, i) => (
                  <li key={i}>
                    length=<strong>{c.length}</strong> · value starts with{" "}
                    <code>{c.value.slice(0, 20)}…</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What <code>getJwt()</code> picks</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {jwt ? (
            <>
              <p>length=<strong>{jwt.length}</strong></p>
              <p className="break-all font-mono text-xs">
                {jwt.slice(0, 60)}…{jwt.slice(-20)}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">No JWT visible.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API health (<code>/api/v2/projects</code>)</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="font-mono text-xs">{apiStatus}</p>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button variant="outline" onClick={refresh}>
          Refresh
        </Button>
        <Button variant="outline" onClick={hardReset}>
          Hard reset (clear all + log in again)
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        If the API status shows ✅ but you still get redirected to login, the
        issue is elsewhere (probably a stale fetch interceptor). If it shows
        ❌ 401, the JWT picked above isn't being accepted by the server —
        clicking Hard reset wipes every (Path, Domain) variant we know how
        to and bounces you to the login page for a clean sign-in.
      </p>
    </div>
  )
}
