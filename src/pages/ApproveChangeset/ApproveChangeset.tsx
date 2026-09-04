// v1 minimal ask-mode approval page (AQU-533 §3, docs/AGENT-API.md "Ask-mode
// confirmation: enforced, not requested"). `get_changeset` hands the agent an
// approval URL of this shape (/approve/:changesetId); a human opens it,
// reviews the server-computed effect summary, and approves or rejects.
//
// The digest used for approval is ALWAYS the one returned by the GET — this
// page never recomputes or reads a digest from the URL, so what's approved
// is provably what the server staged.

import { useCallback, useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AlertCircle, ArrowLeft, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { messageForStatus } from "@/lib/errors/user-error"
import {
  approveChangeset,
  ChangesetApiError,
  fetchChangesetApproval,
  rejectChangeset,
  type ChangesetApproval,
} from "@/lib/agent/changeset-api"
import { t as standaloneT } from "@/lib/i18n/standalone"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { fmtLabeledDateTime } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { ChangeList, ImportPreviewView } from "@/components/changesets/ChangeList"

/** Payload/base-URL/auth plumbing lives in the shared client
 *  (src/lib/agent/changeset-api.ts) — this page and the in-chat
 *  ChangesetCard consume the same route through the same helper. */
type ApprovalData = ChangesetApproval

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

/**
 * AQU-820: the returned string is rendered verbatim, so it is always ours and
 * keyed — the server's `error.message` is untranslated and often a raw
 * diagnostic. The status alone distinguishes the three cases worth naming;
 * anything that isn't an HTTP failure (network drop, timeout) reads as a
 * connectivity problem.
 */
function messageForError(err: unknown): string {
  if (!(err instanceof ChangesetApiError)) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  if (err.status === 403) return standaloneT("error.changeset.notAuthorized")
  if (err.status === 404) return standaloneT("error.changeset.notFound")
  if (err.status === 409) return standaloneT("error.changeset.notApprovable")
  return messageForStatus(err.status, "", "changeset").message
}

export function ApproveChangeset() {
  const t = useT()
  const { changesetId } = useParams<{ changesetId: string }>()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [load, setLoad] = useState<LoadState>({ phase: "loading" })
  const [action, setAction] = useState<ActionState>({ phase: "idle" })

  const jwt = session?.jwt ?? null

  const fetchApproval = useCallback(async () => {
    if (!changesetId || !jwt) return
    setLoad({ phase: "loading" })
    try {
      const data = await fetchChangesetApproval(jwt, changesetId)
      setLoad({ phase: "loaded", data })
    } catch (err) {
      setLoad({ phase: "error", message: messageForError(err) })
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
      // Digest ALWAYS comes from the GET payload — see the header comment.
      await approveChangeset(jwt, changesetId, load.data.digest)
      setAction({ phase: "approved" })
    } catch (err) {
      setAction({ phase: "error", message: messageForError(err) })
    }
  }

  async function reject() {
    if (!changesetId || !jwt) return
    setAction({ phase: "working" })
    try {
      await rejectChangeset(jwt, changesetId)
      setAction({ phase: "rejected" })
    } catch (err) {
      setAction({ phase: "error", message: messageForError(err) })
    }
  }

  const isSignedOut = !sessionLoading && !jwt

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-lg">{t("agent.changeset.approveAgentChanges")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessionLoading ? (
            <div className="flex items-center py-1 text-muted-foreground">
              <Spinner />
            </div>
          ) : isSignedOut ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("agent.changeset.signInNotice")}
              </p>
              <a href={`/login?next=${encodeURIComponent(window.location.pathname)}`}>
                <Button className="w-full">{t("auth.login.submitDefault")}</Button>
              </a>
            </div>
          ) : action.phase === "approved" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              <p className="text-sm font-medium">
                {t("agent.changeset.approvedFull")}
              </p>
              <BackToProjectLink data={load.phase === "loaded" ? load.data : null} />
            </div>
          ) : action.phase === "rejected" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t("agent.changeset.rejectedFull")}
              </p>
              <BackToProjectLink data={load.phase === "loaded" ? load.data : null} />
            </div>
          ) : load.phase === "loading" ? (
            <div className="flex items-center gap-2 py-1">
              <Spinner className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("agent.changeset.loading")}</p>
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

/** Post-action escape hatch: approving used to strand the reviewer on this
 *  full-screen page with only the browser back button (Joel's feedback) —
 *  always offer the way back into the project. */
function BackToProjectLink({ data }: { data: ApprovalData | null }) {
  const t = useT()
  if (!data) return null
  return (
    <Link
      to={`/project/${data.projectId}`}
      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
    >
      <ArrowLeft className="h-3 w-3" />
      {t("agent.changeset.backTo", { projectName: data.projectName ?? "project" })}
    </Link>
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
  const { locale, t } = useI18n()
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
        <p className="text-sm text-muted-foreground">{t("common.project")}</p>
        <p className="text-sm font-medium">{data.projectName ?? data.projectId}</p>
      </div>

      {notStaged && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t("agent.changeset.notStagedNotice", { status: data.status })}
        </p>
      )}

      <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
        <p className="text-sm font-medium">{t("agent.changeset.whatWillBeApplied")}</p>
        {factEntries.length === 0 && settingsEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("agent.changeset.noChangesSummarized")}</p>
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
            <p className="text-xs font-medium">{t("agent.changeset.settingsChanges")}</p>
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

      {data.changes && data.changes.items.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            {t("agent.changeset.changesHeading", { count: data.changes.total })}
          </p>
          <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-md border bg-muted/30 p-2">
            <ChangeList changes={data.changes} />
          </div>
        </div>
      )}

      {data.importPreview && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("importExport.dialog.titlePreview")}</p>
          <div className="max-h-96 space-y-1.5 overflow-y-auto rounded-md border bg-muted/30 p-2">
            <ImportPreviewView preview={data.importPreview} />
          </div>
        </div>
      )}

      {warnings && warnings.length > 0 && (
        <div className="rounded-md border border-amber-300/50 bg-amber-50 p-3 space-y-1 dark:bg-amber-950/20">
          <p className="text-sm font-medium">{t("agent.changeset.warnings")}</p>
          <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("agent.changeset.digestLabel")} <span className="font-mono">{data.digest.slice(0, 16)}…</span></span>
        <span>
          <DateTooltip value={data.expiresAt} label={t("common.date.expires")}>
            {/* AQU-1177: the visible label carries the TIME, not just the day.
                Ask-mode plans now live 24h, so "Expires September 5" leaves the
                reviewer unable to tell whether they have ten hours or ten
                minutes — exactly the question the deadline is here to answer. */}
            {t("common.expiresOn", {
              date: fmtLabeledDateTime(data.expiresAt, "", undefined, locale),
            })}
          </DateTooltip>
        </span>
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
          {t("agent.approve")}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={onReject}
          disabled={working || notStaged}
        >
          {t("agent.reject")}
        </Button>
      </div>

      <div className="text-center">
        <BackToProjectLink data={data} />
      </div>
    </div>
  )
}
