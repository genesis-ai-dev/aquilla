// "Set up with AI" — the one-dialog path from nothing to progress landing on a
// Monday board.
//
// Deliberately NOT a chat. It's a linear state machine with gates:
//
//   intro → [connect] → scanning → review → applying → done
//
// The AI runs once, unattended, and proposes EVERYTHING (which board, item
// granularity, every column↔metric pair). The user's job is to correct a
// proposal, not to answer questions — every question we'd ask is a scan we
// failed to do. Corrections use the same row controls as the saved-mapping
// editor, and "done" is only claimed after a real push has landed.
//
// The AI can never widen what gets written: the server clamps every proposal
// through sanitizeMapping, and read-only Monday column types stay out of the
// pickers.

import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, ExternalLink, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  analyzeMondayMapping,
  deleteMondayLink,
  fetchMondayBoards,
  fetchMondayBoardStructure,
  MondayApiError,
  putMondayLink,
  startMondayConnect,
  syncMondayNow,
  type MondayAnalysis,
  type MondayBoard,
  type MondayBoardLink,
  type MondayBoardStructure,
} from "@/lib/monday/api"
import type { MondayColumnMapping, MondayMapping } from "@/lib/monday/types"
import { MondayMappingRows } from "./MondayMappingEditor"

type Stage = "intro" | "connect" | "scanning" | "review" | "applying" | "done"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  orgId: number | null
  jwt: string | null
  /** Whether the org already holds a Monday connection. */
  orgConnected: boolean
  /** Monday account slug, for the "View board" deep link. */
  accountSlug?: string | null
  /** A link was created — parent refreshes its own view. */
  onLinked: (link: MondayBoardLink) => void
  /** The wizard's Undo removed the link it had just created. */
  onUnlinked: () => void
  /** OAuth completed in the other tab — parent refetches connection status. */
  onConnected: () => void
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** One row of the scan checklist — pending, running, or done. */
function ScanStep({ state, label }: { state: "pending" | "running" | "done"; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {state === "done" ? (
        <Check className="h-4 w-4 text-primary" />
      ) : state === "running" ? (
        <Spinner className="h-4 w-4" />
      ) : (
        <span className="h-4 w-4 rounded-full border border-muted-foreground/40" />
      )}
      <span className={state === "pending" ? "text-muted-foreground" : ""}>{label}</span>
    </li>
  )
}

export function MondaySetupWizard({
  open,
  onOpenChange,
  projectId,
  orgId,
  jwt,
  orgConnected,
  accountSlug,
  onLinked,
  onUnlinked,
  onConnected,
}: Props) {
  const [stage, setStage] = useState<Stage>("intro")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [analysis, setAnalysis] = useState<MondayAnalysis | null>(null)
  const [structure, setStructure] = useState<MondayBoardStructure | null>(null)
  const [rows, setRows] = useState<MondayColumnMapping[]>([])
  const [granularity, setGranularity] = useState<MondayMapping["itemGranularity"]>("project")
  /** Which of the two scan steps has completed (0 = none). */
  const [scanDone, setScanDone] = useState(0)

  const [boards, setBoards] = useState<MondayBoard[] | null>(null)
  const [changingBoard, setChangingBoard] = useState(false)

  const [linkedBoardName, setLinkedBoardName] = useState<string | null>(null)
  const [pushNotice, setPushNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [awaitingOAuth, setAwaitingOAuth] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Reset to a clean intro every time the dialog is opened, so a previous
  // run's proposal or error never greets the next one.
  useEffect(() => {
    if (!open) return
    setStage("intro")
    setError(null)
    setAnalysis(null)
    setStructure(null)
    setRows([])
    setScanDone(0)
    setChangingBoard(false)
    setLinkedBoardName(null)
    setPushNotice(null)
    setAwaitingOAuth(false)
  }, [open])

  // ── Scan: one analyze call, then the chosen board's structure ────────────
  const runScan = useCallback(
    async (boardId?: string) => {
      if (!jwt) return
      setStage("scanning")
      setError(null)
      setScanDone(0)
      setChangingBoard(false)
      try {
        const got = await analyzeMondayMapping(jwt, projectId, boardId ? { boardId } : {})
        if (!aliveRef.current) return
        setAnalysis(got)
        setRows(got.proposal.columns)
        setGranularity(got.proposal.itemGranularity)
        setScanDone(1)

        // Structure gives the review table real column titles instead of raw
        // ids. It needs ORG maintainer server-side, so a 403 degrades quietly.
        if (orgId != null && got.boardId) {
          const built = await fetchMondayBoardStructure(jwt, orgId, got.boardId).catch(() => null)
          if (!aliveRef.current) return
          setStructure(built)
        }
        setScanDone(2)
        setStage("review")
      } catch (e) {
        if (!aliveRef.current) return
        // 409 = the account has no boards to sync to. Retrying can't fix that,
        // so say what to do instead of offering "Scan and propose" again.
        setError(
          e instanceof MondayApiError && e.status === 409 && /no boards/i.test(e.message)
            ? "This Monday account has no boards yet. Create one in Monday, then run setup again."
            : errMsg(e),
        )
        setStage("intro")
      }
    },
    [jwt, projectId, orgId],
  )

  // ── Connect gate (org has no Monday connection yet) ──────────────────────
  // Same new-tab dance as org settings: open the tab synchronously inside the
  // click so popup blockers don't eat it, then refetch on focus.
  const handleConnect = useCallback(async () => {
    if (!jwt || orgId == null) return
    setBusy(true)
    setError(null)
    const popup = window.open("about:blank", "_blank")
    try {
      const { url } = await startMondayConnect(
        jwt,
        orgId,
        `/project/${projectId}/settings/integrations`,
      )
      if (popup && !popup.closed) {
        popup.location.href = url
      } else {
        window.location.assign(url)
        return
      }
      setAwaitingOAuth(true)
    } catch (e) {
      popup?.close()
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [jwt, orgId, projectId])

  useEffect(() => {
    if (!awaitingOAuth) return
    const onFocus = () => onConnected()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [awaitingOAuth, onConnected])

  // The parent's connection refetch lands here: leave the connect gate and go
  // straight into the scan the user already asked for.
  useEffect(() => {
    if (stage === "connect" && orgConnected) void runScan()
  }, [stage, orgConnected, runScan])

  const handleStart = useCallback(() => {
    if (!orgConnected) {
      setStage("connect")
      return
    }
    void runScan()
  }, [orgConnected, runScan])

  // ── Board change ─────────────────────────────────────────────────────────
  const openBoardPicker = useCallback(async () => {
    setChangingBoard(true)
    if (boards !== null || !jwt || orgId == null) return
    try {
      const got = await fetchMondayBoards(jwt, orgId)
      if (aliveRef.current) setBoards(got)
    } catch {
      // Board listing needs org maintainer; without it the AI's pick stands.
      if (aliveRef.current) setBoards([])
    }
  }, [boards, jwt, orgId])

  // ── Apply: create the link, then prove it by pushing ─────────────────────
  const handleApply = useCallback(async () => {
    if (!jwt || !analysis) return
    setStage("applying")
    setError(null)
    const boardName = analysis.boardName ?? boards?.find((b) => b.id === analysis.boardId)?.name

    // The AI writes itemNameTemplate for the granularity it proposed. If the
    // user flips that here, the template no longer fits — a project-shaped
    // "{projectName}" would name every file item identically (and, under
    // matchExisting byName, collapse them onto one board item). Drop it and let
    // the server pick its granularity-correct default.
    const { itemNameTemplate, ...rest } = analysis.proposal
    const keepTemplate = granularity === analysis.proposal.itemGranularity && itemNameTemplate

    try {
      const out = await putMondayLink(jwt, projectId, {
        boardId: analysis.boardId,
        ...(boardName ? { boardName } : {}),
        config: {
          ...rest,
          ...(keepTemplate ? { itemNameTemplate } : {}),
          itemGranularity: granularity,
          columns: rows.filter((r) => r.columnId),
        },
      })
      if (!aliveRef.current) return
      setLinkedBoardName(out.link.boardName ?? boardName ?? null)
      onLinked(out.link)

      // Verify rather than assert: a link that pushes nothing is not "set up".
      try {
        const res = await syncMondayNow(jwt, projectId)
        if (!aliveRef.current) return
        setPushNotice(
          res.ok
            ? {
                ok: true,
                text:
                  res.itemsUpserted != null
                    ? `Pushed ${res.itemsUpserted} item${res.itemsUpserted === 1 ? "" : "s"}.`
                    : "Pushed this project's progress.",
              }
            : { ok: false, text: res.error ?? "The first push didn't go through." },
        )
      } catch (e) {
        if (aliveRef.current) setPushNotice({ ok: false, text: errMsg(e) })
      }
      if (aliveRef.current) setStage("done")
    } catch (e) {
      if (!aliveRef.current) return
      setError(errMsg(e))
      setStage("review")
    }
  }, [jwt, analysis, projectId, granularity, rows, boards, onLinked])

  const handleUndo = useCallback(async () => {
    if (!jwt) return
    setBusy(true)
    try {
      await deleteMondayLink(jwt, projectId)
      if (!aliveRef.current) return
      onUnlinked()
      onOpenChange(false)
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [jwt, projectId, onUnlinked, onOpenChange])

  const boardUrl =
    accountSlug && analysis?.boardId
      ? `https://${accountSlug}.monday.com/boards/${analysis.boardId}`
      : null
  const mappedCount = rows.filter((r) => r.columnId).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="monday-setup-wizard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {stage === "done" ? "Monday.com is set up" : "Set up Monday.com with AI"}
          </DialogTitle>
          {stage === "intro" && (
            <DialogDescription>
              Aquilla reads your Monday board names and columns plus this project's progress
              figures, then proposes which board to use and what to push to each column. Nothing
              is written to Monday until you approve it.
            </DialogDescription>
          )}
        </DialogHeader>

        {stage === "intro" && (
          <div className="space-y-3">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· Picks the board that best matches this project</li>
              <li>· Maps completion, validation and activity metrics to suitable columns</li>
              <li>· Skips columns Monday won't let anything write to</li>
            </ul>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "connect" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your organization isn't connected to Monday.com yet. Connecting opens Monday in a new
              tab; come back here when it's done and setup continues automatically.
            </p>
            {awaitingOAuth && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" /> Waiting for Monday…
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "scanning" && (
          <ul className="space-y-2 py-2" data-testid="monday-wizard-scan">
            <ScanStep
              state={scanDone >= 1 ? "done" : "running"}
              label="Reading this project and your Monday boards"
            />
            <ScanStep
              state={scanDone >= 2 ? "done" : scanDone >= 1 ? "running" : "pending"}
              label="Matching progress metrics to board columns"
            />
          </ul>
        )}

        {stage === "review" && analysis && (
          <div className="space-y-4" data-testid="monday-wizard-review">
            <p className="text-sm">{analysis.summary}</p>

            <div className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Board</p>
                  <p className="text-sm font-medium break-words">
                    {analysis.boardName ??
                      boards?.find((b) => b.id === analysis.boardId)?.name ??
                      analysis.boardId}
                  </p>
                </div>
                {!changingBoard && (
                  <Button variant="outline" size="sm" onClick={() => void openBoardPicker()}>
                    Change
                  </Button>
                )}
              </div>
              {analysis.boardReason && !changingBoard && (
                <p className="mt-1 text-xs text-muted-foreground">{analysis.boardReason}</p>
              )}
              {changingBoard && (
                <div className="mt-2">
                  {boards === null ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner className="h-4 w-4" /> Loading boards…
                    </p>
                  ) : boards.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Couldn't list boards — an org maintainer can change the board later.
                    </p>
                  ) : (
                    <Select
                      items={Object.fromEntries(boards.map((b) => [b.id, b.name]))}
                      value={analysis.boardId || null}
                      onValueChange={(value) => {
                        const id = (value as string) ?? ""
                        if (id && id !== analysis.boardId) void runScan(id)
                      }}
                    >
                      <SelectTrigger aria-label="Monday board" className="w-full">
                        <SelectValue placeholder="Pick a board" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {boards.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                              {b.workspace?.name ? ` — ${b.workspace.name}` : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>

            <div>
              <p className="mb-1 text-xs text-muted-foreground">Board items</p>
              <Select
                items={{
                  project: "One item for the whole project",
                  file: "One item per file",
                }}
                value={granularity}
                onValueChange={(value) =>
                  setGranularity((value as MondayMapping["itemGranularity"]) ?? "project")
                }
              >
                <SelectTrigger aria-label="Board items" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="project">One item for the whole project</SelectItem>
                    <SelectItem value="file">One item per file</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {analysis.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Some columns were skipped
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {analysis.warnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                What gets pushed — change any row before applying
              </p>
              <MondayMappingRows
                rows={rows}
                structure={structure}
                disabled={false}
                onChange={setRows}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "applying" && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> Linking the board and pushing your progress…
          </p>
        )}

        {stage === "done" && (
          <div className="space-y-3" data-testid="monday-wizard-done">
            <p className="text-sm">
              {linkedBoardName
                ? `This project now syncs to ${linkedBoardName}.`
                : "This project now syncs to Monday."}{" "}
              Progress pushes automatically as translators work.
            </p>
            {pushNotice && (
              <p
                className={
                  pushNotice.ok
                    ? "flex items-center gap-1.5 text-sm text-muted-foreground"
                    : "flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-500"
                }
              >
                {pushNotice.ok ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                {pushNotice.ok
                  ? pushNotice.text
                  : `Linked, but the first push failed: ${pushNotice.text} You can retry with Sync now.`}
              </p>
            )}
            {boardUrl && (
              <a
                href={boardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
              >
                View board on Monday <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {stage === "intro" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={!jwt}>
                <Sparkles data-icon="inline-start" />
                {orgConnected ? "Scan and propose" : "Connect and scan"}
              </Button>
            </>
          )}
          {stage === "connect" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleConnect()} disabled={busy || orgId == null}>
                {busy && <Spinner data-icon="inline-start" />}
                Connect Monday.com
              </Button>
            </>
          )}
          {stage === "review" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void handleApply()} disabled={mappedCount === 0}>
                Apply and push
              </Button>
            </>
          )}
          {stage === "done" && (
            <>
              <Button variant="ghost" onClick={() => void handleUndo()} disabled={busy}>
                {busy && <Spinner data-icon="inline-start" />}
                Undo
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
