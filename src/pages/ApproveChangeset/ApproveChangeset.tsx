// v1 minimal ask-mode approval page (AQU-533 §3, docs/AGENT-API.md "Ask-mode
// confirmation: enforced, not requested"). `get_changeset` hands the agent an
// approval URL of this shape (/approve/:changesetId); a human opens it,
// reviews the server-computed effect summary, and approves or rejects.
//
// The digest used for approval is ALWAYS the one returned by the GET — this
// page never recomputes or reads a digest from the URL, so what's approved
// is provably what the server staged.

import { useCallback, useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { AlertCircle, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { AUTH_BASE } from "@/lib/frontier/auth"

interface ApprovalSummary {
  warnings?: { message: string }[]
  /** UpdateProjectSettings: per-key truncated previews of the settings being
   *  written (an object, so it needs explicit rendering below — the flat
   *  number/string fact loop skips it). */
  settingsChanges?: Record<string, string>
  [key: string]: unknown
}

interface ApprovalData {
  changesetId: string
  projectId: string
  projectName: string | null
  status: string
  autonomyMode: string
  summary: ApprovalSummary
  digest: string
  createdAt: string
  expiresAt: string
}

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; data: ApprovalData }
  | { phase: "error"; message: string }

type ActionState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "approved" }
  | { phase: "rejected" }
  | { phase: "error"; message: string }

/** Turn `translationsAdded` / `translations_added` into "Translations added". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) return body.error.message
  } catch {
    // fall through to status-based messages
  }
  if (res.status === 403) return "You aren't authorized to view this approval."
  if (res.status === 404) return "This changeset couldn't be found."
  if (res.status === 409) return "This changeset can no longer be approved."
  return `Something went wrong (${res.status}).`
}

export function ApproveChangeset() {
  const { changesetId } = useParams<{ changesetId: string }>()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [load, setLoad] = useState<LoadState>({ phase: "loading" })
  const [action, setAction] = useState<ActionState>({ phase: "idle" })

  const jwt = session?.jwt ?? null

  const fetchApproval = useCallback(async () => {
    if (!changesetId || !jwt) return
    setLoad({ phase: "loading" })
    try {
      const res = await fetch(`${AUTH_BASE}/api/v2/changesets/${changesetId}/approval`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (!res.ok) {
        setLoad({ phase: "error", message: await parseErrorMessage(res) })
        return
      }
      const data = (await res.json()) as ApprovalData
      setLoad({ phase: "loaded", data })
    } catch {
      setLoad({ phase: "error", message: "Couldn't reach the server. Check your connection and try again." })
    }
  }, [changesetId, jwt])

  useEffect(() => {
    if (sessionLoading) return
    if (!jwt) return
    void fetchApproval()
  }, [sessionLoading, jwt, fetchApproval])

  async function approve() {
    if (!changesetId || !jwt || load.phase !== "loaded") return
    setAction({ phase: "working" })
    try {
      const res = await fetch(`${AUTH_BASE}/api/v2/changesets/${changesetId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ digest: load.data.digest }),
      })
      if (!res.ok) {
        setAction({ phase: "error", message: await parseErrorMessage(res) })
        return
      }
      setAction({ phase: "approved" })
    } catch {
      setAction({ phase: "error", message: "Couldn't reach the server. Check your connection and try again." })
    }
  }

  async function reject() {
    if (!changesetId || !jwt) return
    setAction({ phase: "working" })
    try {
      const res = await fetch(`${AUTH_BASE}/api/v2/changesets/${changesetId}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      })
      if (!res.ok) {
        setAction({ phase: "error", message: await parseErrorMessage(res) })
        return
      }
      setAction({ phase: "rejected" })
    } catch {
      setAction({ phase: "error", message: "Couldn't reach the server. Check your connection and try again." })
    }
  }

  const isSignedOut = !sessionLoading && !jwt

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-lg">Approve agent changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessionLoading ? (
            <div className="flex items-center gap-2 py-1">
              <Spinner className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
          ) : isSignedOut ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Sign in to review and approve this changeset.
              </p>
              <a href={`/login?next=${encodeURIComponent(window.location.pathname)}`}>
                <Button className="w-full">Sign in</Button>
              </a>
            </div>
          ) : action.phase === "approved" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              <p className="text-sm font-medium">
                Approved — return to your agent, it can now commit.
              </p>
            </div>
          ) : action.phase === "rejected" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                Rejected — the changeset was discarded.
              </p>
            </div>
          ) : load.phase === "loading" ? (
            <div className="flex items-center gap-2 py-1">
              <Spinner className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading changeset…</p>
            </div>
          ) : load.phase === "error" ? (
            <div className="space-y-1">
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
                <p className="text-sm">{load.message}</p>
              </div>
            </div>
          ) : (
            <ApprovalSummaryView
              data={load.data}
              actionPhase={action.phase}
              actionError={action.phase === "error" ? action.message : null}
              onApprove={() => void approve()}
              onReject={() => void reject()}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ApprovalSummaryView({
  data,
  actionPhase,
  actionError,
  onApprove,
  onReject,
}: {
  data: ApprovalData
  actionPhase: ActionState["phase"]
  actionError: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const { warnings, settingsChanges, ...facts } = data.summary
  const factEntries = Object.entries(facts).filter(([, v]) => typeof v === "number" || typeof v === "string")
  const settingsEntries =
    settingsChanges && typeof settingsChanges === "object"
      ? Object.entries(settingsChanges).filter(([, v]) => typeof v === "string")
      : []
  const notStaged = data.status !== "staged"
  const working = actionPhase === "working"

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Project</p>
        <p className="text-sm font-medium">{data.projectName ?? data.projectId}</p>
      </div>

      {notStaged && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          This changeset is currently {data.status} and can no longer be approved.
        </p>
      )}

      <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
        <p className="text-sm font-medium">What will be applied</p>
        {factEntries.length === 0 && settingsEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No changes summarized.</p>
        ) : (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {factEntries.map(([key, value]) => (
              <li key={key}>
                {humanizeKey(key)}: <span className="font-medium text-foreground">{String(value)}</span>
              </li>
            ))}
          </ul>
        )}
        {settingsEntries.length > 0 && (
          <div className="space-y-0.5 pt-1">
            <p className="text-xs font-medium">Settings changes</p>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {settingsEntries.map(([key, value]) => (
                <li key={key}>
                  <span className="font-mono">{key}</span>:{" "}
                  <span className="font-medium text-foreground">{value}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {warnings && warnings.length > 0 && (
        <div className="rounded-md border border-amber-300/50 bg-amber-50 p-3 space-y-1 dark:bg-amber-950/20">
          <p className="text-sm font-medium">Warnings</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Digest: <span className="font-mono">{data.digest.slice(0, 16)}…</span></span>
        <span>Expires {new Date(data.expiresAt).toLocaleString()}</span>
      </div>

      {actionError && (
        <div className="flex items-start gap-2 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="text-xs">{actionError}</p>
        </div>
      )}

      <div className="flex gap-2">
        <Button className="flex-1" onClick={onApprove} disabled={working || notStaged}>
          {working ? <Spinner data-icon="inline-start" /> : null}
          Approve
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={onReject}
          disabled={working || notStaged}
        >
          Reject
        </Button>
      </div>
    </div>
  )
}
