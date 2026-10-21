// Monday board setup: three short steps from nothing to progress landing on a
// Monday board.
//
//   intro → [connect] → scanning → 1 board → 2 columns → 3 confirm → applying → done
//
// One decision per step, with sensible choices already made:
//   1. Which board? The AI's pick (and why), with a way to change it.
//   2. What should your board show? Every column Aquilla can fill, grouped,
//      with the recommended ones and anything already on the board ticked.
//   3. Confirm. A plain summary, and one button that says what happens:
//      "Add columns and connect" (or "Connect" when nothing new is needed).
//
// Nothing is written to Monday before step 3: columns are created only on
// confirm, then mapped, linked and pushed. "Done" is only claimed after a real
// push has landed.
//
// The manual path (mode "manual") is the same flow without the AI: the user
// picks the board, and step 2's "Advanced: match columns myself" lets them send
// a number to any existing column.
//
// The AI can never widen what gets written: the server clamps every proposal
// through sanitizeMapping, and read-only Monday column types stay out of the
// pickers.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
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
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"
import {
  addMondayColumns,
  analyzeMondayMapping,
  createMondayBoard,
  deleteMondayLink,
  fetchMondayBoards,
  fetchMondayBoardStructure,
  MondayApiError,
  putMondayLink,
  startMondayConnect,
  syncMondayNow,
  type MondayAddColumnsResult,
  type MondayAnalysis,
  type MondayBoard,
  type MondayBoardLink,
  type MondayBoardStructure,
  type MondayNewBoardResult,
} from "@/lib/monday/api"
import { connectFailureKey, useMondayOAuthOutcome } from "@/lib/monday/oauth-return"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { openExternal } from "@/lib/open-external"
import type { MondayColumnMapping, MondayMapping, MondayMetricKey } from "@/lib/monday/types"
import {
  REQUIRED_METRIC,
  columnSelectionCounts,
  initialColumnSelection,
  metricsToAdd,
  newBoardMetrics,
  selectedRows,
} from "@/lib/monday/column-selection"
import { MondayMappingRows } from "./MondayMappingEditor"
import { MondayColumnChooser } from "./MondayColumnChooser"
import { useT } from "@/lib/i18n/I18nProvider"

type Stage = "intro" | "connect" | "scanning" | "board" | "columns" | "confirm" | "applying" | "done"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  orgId: number | null
  jwt: string | null
  /** Whether the org already holds a Monday connection. */
  orgConnected: boolean
  /** "manual": the user picks the board and nothing is asked of the AI. */
  mode?: "ai" | "manual"
  /**
   * A link was created — parent refreshes its own view and keeps showing the
   * server's link warnings (e.g. webhooks could not be created).
   */
  onLinked: (link: MondayBoardLink, warnings: string[]) => void
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

/**
 * The server's own words for a failed call: readError keeps them in `cause`
 * ("HTTP 409 — no boards found…") behind a generic message.
 */
function serverReason(e: unknown): string {
  const detail = e instanceof MondayApiError && typeof e.cause === "string" ? /— (.+)$/s.exec(e.cause)?.[1] : undefined
  return detail ?? errMsg(e)
}

/** One of step 1's two choices: a radio and its words, with anything it needs below. */
function BoardChoice({
  value,
  selected,
  label,
  help,
  aside,
  children,
}: {
  value: "existing" | "new"
  selected: boolean
  label: string
  help?: string
  aside?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-3", selected ? "border-primary/40 bg-muted/40" : "")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex min-w-0 flex-1 items-start gap-2.5 text-sm">
          <RadioGroupItem value={value} className="mt-0.5 shrink-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium break-words">{label}</span>
            {help && <span className="text-xs text-muted-foreground">{help}</span>}
          </span>
        </label>
        {aside}
      </div>
      {children}
    </div>
  )
}

const STEP_NUMBER: Partial<Record<Stage, number>> = { board: 1, columns: 2, confirm: 3 }

export function MondaySetupWizard({
  open,
  onOpenChange,
  projectId,
  orgId,
  jwt,
  orgConnected,
  mode = "ai",
  onLinked,
  onUnlinked,
  onConnected,
}: Props) {
  const t = useT()
  const manual = mode === "manual"
  const [stage, setStage] = useState<Stage>("intro")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [analysis, setAnalysis] = useState<MondayAnalysis | null>(null)
  const [boardId, setBoardId] = useState("")
  const [structure, setStructure] = useState<MondayBoardStructure | null>(null)
  const [rows, setRows] = useState<MondayColumnMapping[]>([])
  const [granularity, setGranularity] = useState<MondayMapping["itemGranularity"]>("project")
  const [selected, setSelected] = useState<Set<MondayMetricKey>>(new Set([REQUIRED_METRIC]))
  const [advanced, setAdvanced] = useState(false)
  /** Which of the two scan steps has completed (0 = none). */
  const [scanDone, setScanDone] = useState(0)

  const [boards, setBoards] = useState<MondayBoard[] | null>(null)
  const [changingBoard, setChangingBoard] = useState(false)

  const [applyStep, setApplyStep] = useState<"making" | "adding" | "linking">("linking")
  const [notAdded, setNotAdded] = useState<MondayAddColumnsResult["failed"]>([])
  const [linkedBoardUrl, setLinkedBoardUrl] = useState<string | null>(null)
  const [linkedBoardName, setLinkedBoardName] = useState<string | null>(null)
  const [pushNotice, setPushNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** Warnings the link route returned — the same ones the manual path shows. */
  const [linkWarnings, setLinkWarnings] = useState<string[]>([])
  const [awaitingOAuth, setAwaitingOAuth] = useState(false)

  // AQU-2087: step 1's other choice. Aquilla makes a clean board instead of
  // linking one of the user's; its columns are ticked apart from an existing
  // board's, so switching back and forth loses neither.
  const [newBoard, setNewBoard] = useState(false)
  const [newBoardName, setNewBoardName] = useState("")
  const [newSelected, setNewSelected] = useState<Set<MondayMetricKey>>(
    () => initialColumnSelection([], undefined, { recommend: true }),
  )
  /** The Monday account has no boards at all, so a new one is the only choice. */
  const [noBoards, setNoBoards] = useState(false)
  /** The board this run already made, so a retry after a failed link doesn't make another. */
  const [madeBoard, setMadeBoard] = useState<MondayNewBoardResult | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // ── Board list (the change-board dropdown, and the manual path's step 1) ──
  const loadBoards = useCallback(async () => {
    if (boards !== null || !jwt || orgId == null) return
    try {
      const got = await fetchMondayBoards(jwt, orgId)
      if (aliveRef.current) setBoards(got)
    } catch {
      // Board listing needs org maintainer; without it the AI's pick stands.
      if (aliveRef.current) setBoards([])
    }
  }, [boards, jwt, orgId])

  // Reset every time the dialog is opened, so a previous run's proposal or
  // error never greets the next one.
  useEffect(() => {
    if (!open) return
    setStage(manual ? "board" : "intro")
    setError(null)
    setAnalysis(null)
    setBoardId("")
    setStructure(null)
    setRows([])
    setGranularity("project")
    setSelected(new Set([REQUIRED_METRIC]))
    setAdvanced(false)
    setScanDone(0)
    setChangingBoard(false)
    setNotAdded([])
    setLinkedBoardName(null)
    setLinkedBoardUrl(null)
    setPushNotice(null)
    setLinkWarnings([])
    setAwaitingOAuth(false)
    setNewBoard(false)
    setNewBoardName(t("projectSettings.monday.newBoardDefaultName"))
    setNewSelected(initialColumnSelection([], undefined, { recommend: true }))
    setNoBoards(false)
    setMadeBoard(null)
    // Only on open; the manual path's board list loads below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && manual && stage === "board") void loadBoards()
  }, [open, manual, stage, loadBoards])

  /** The board's columns: needed for real titles and for "On your board". */
  const loadStructure = useCallback(
    async (id: string): Promise<MondayBoardStructure | null> => {
      if (!jwt || orgId == null || !id) return null
      // Needs ORG maintainer server-side, so a 403 degrades quietly.
      return fetchMondayBoardStructure(jwt, orgId, id).catch(() => null)
    },
    [jwt, orgId],
  )

  // ── Scan (AI path): one analyze call, then the chosen board's structure ──
  const runScan = useCallback(
    async (pickBoardId?: string) => {
      if (!jwt) return
      setStage("scanning")
      setError(null)
      setScanDone(0)
      setChangingBoard(false)
      try {
        const got = await analyzeMondayMapping(jwt, projectId, pickBoardId ? { boardId: pickBoardId } : {})
        if (!aliveRef.current) return
        setAnalysis(got)
        setBoardId(got.boardId)
        setRows(got.proposal.columns)
        setGranularity(got.proposal.itemGranularity)
        setScanDone(1)
        const built = got.boardId ? await loadStructure(got.boardId) : null
        if (!aliveRef.current) return
        setStructure(built)
        setSelected(initialColumnSelection(got.proposal.columns, built?.columns, { recommend: true }))
        setScanDone(2)
        setStage("board")
      } catch (e) {
        if (!aliveRef.current) return
        // 409 = the account has no boards to sync to. Retrying can't fix that,
        // and AQU-2087 means it needn't: step 1 opens on making one.
        if (e instanceof MondayApiError && e.status === 409 && /no boards/i.test(serverReason(e))) {
          setNoBoards(true)
          setNewBoard(true)
          setStage("board")
          return
        }
        setError(errMsg(e))
        setStage("intro")
      }
    },
    [jwt, projectId, loadStructure],
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
      const { url } = await startMondayConnect(jwt, orgId, `/project/${projectId}/settings/integrations`)
      if (popup && !popup.closed) {
        popup.location.href = url
      } else if (isTauriRuntime()) {
        // The desktop WebView has no popups; use the system browser.
        await openExternal(url)
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
  // The Monday tab says how it ended (or the wait times out), so a cancelled
  // or failed connection doesn't leave "Waiting for Monday…" up forever.
  useMondayOAuthOutcome(awaitingOAuth, orgId, (outcome) => {
    setAwaitingOAuth(false)
    if (outcome.ok) onConnected()
    else setError(t(connectFailureKey(outcome.reason)))
  })

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

  // ── Step 1 → 2 ───────────────────────────────────────────────────────────
  const goToColumns = useCallback(async () => {
    if (manual && !newBoard) {
      // No AI: read the board, then tick what's already there plus the
      // recommended set.
      setBusy(true)
      const built = await loadStructure(boardId)
      if (!aliveRef.current) return
      setBusy(false)
      setStructure(built)
      setRows([])
      setSelected(initialColumnSelection([], built?.columns, { recommend: true }))
    }
    setError(null)
    setStage("columns")
  }, [manual, newBoard, boardId, loadStructure])

  // Advanced matching: a number sent to an existing column is used, so tick it.
  const handleAdvancedRows = useCallback((next: MondayColumnMapping[]) => {
    setRows(next)
    setSelected((prev) => {
      const out = new Set(prev)
      for (const r of next) if (r.columnId) out.add(r.metric)
      return out
    })
  }, [])

  // ── Step 3: create the new columns, then link and prove it by pushing ────
  const boards_ = boards ?? []
  const existingBoardName =
    analysis?.boardName ?? boards_.find((b) => b.id === boardId)?.name ?? structure?.name ?? boardId
  const typedBoardName = newBoardName.trim() || t("projectSettings.monday.newBoardDefaultName")
  const boardName = newBoard ? typedBoardName : existingBoardName
  // A new board has no columns of its own and nothing for the AI's rows to point at.
  const chooserRows = newBoard ? [] : rows
  const chooserColumns = newBoard ? undefined : structure?.columns
  const ticks = newBoard ? newSelected : selected
  const setTicks = newBoard ? setNewSelected : setSelected
  const { adds } = columnSelectionCounts(ticks, chooserRows, chooserColumns)
  const pickedBeyondId = [...ticks].some((m) => m !== REQUIRED_METRIC)

  const handleConfirm = useCallback(async () => {
    if (!jwt || (!newBoard && !boardId)) return
    setStage("applying")
    setError(null)
    setNotAdded([])

    let added: MondayAddColumnsResult | null = null
    let linkBoardId = boardId
    let linkBoardName: string | null = boardName
    if (newBoard) {
      // AQU-2087: make the board first (once per run), then link it like any other.
      let made = madeBoard
      if (!made) {
        setApplyStep("making")
        try {
          made = await createMondayBoard(jwt, projectId, { name: typedBoardName, metrics: newBoardMetrics(newSelected) })
        } catch (e) {
          if (!aliveRef.current) return
          setError(t("projectSettings.monday.wizardNewBoardFailed", { reason: serverReason(e) }))
          setStage("confirm")
          return
        }
        if (!aliveRef.current) return
        setMadeBoard(made)
      }
      added = made
      linkBoardId = made.boardId
      linkBoardName = made.structure.name ?? typedBoardName
      setBoardId(made.boardId)
      setStructure(made.structure)
      setNotAdded(made.failed)
    } else {
      const need = metricsToAdd(selected, rows)
      if (need.length > 0) {
        setApplyStep("adding")
        try {
          added = await addMondayColumns(jwt, projectId, { boardId, metrics: need })
          if (!aliveRef.current) return
          setStructure(added.structure)
          setNotAdded(added.failed)
        } catch (e) {
          if (!aliveRef.current) return
          setError(t("projectSettings.monday.wizardAddColumnsFailed", { reason: errMsg(e) }))
          setStage("confirm")
          return
        }
      }
    }
    setApplyStep("linking")

    // The AI writes itemNameTemplate for the granularity it proposed. If the
    // user flips that, the template no longer fits — a project-shaped
    // "{projectName}" would name every file item identically (and, under
    // matchExisting byName, collapse them onto one board item). Drop it and let
    // the server pick its granularity-correct default. A new board ignores the
    // AI's proposal altogether: it was made for another board.
    const proposal = newBoard ? undefined : analysis?.proposal
    const { itemNameTemplate: template, ...rest } = proposal ?? {
      version: 1 as const,
      itemGranularity: granularity,
      columns: [] as MondayColumnMapping[],
    }
    const keepTemplate = proposal && granularity === proposal.itemGranularity && template

    try {
      const out = await putMondayLink(jwt, projectId, {
        boardId: linkBoardId,
        ...(linkBoardName ? { boardName: linkBoardName } : {}),
        config: {
          ...rest,
          ...(keepTemplate ? { itemNameTemplate: template } : {}),
          itemGranularity: granularity,
          columns: newBoard ? selectedRows([], newSelected, added) : selectedRows(rows, selected, added),
        },
      })
      if (!aliveRef.current) return
      setLinkedBoardUrl(out.link.boardUrl ?? added?.structure.url ?? structure?.url ?? analysis?.boardUrl ?? null)
      setLinkedBoardName(out.link.boardName ?? linkBoardName ?? null)
      setLinkWarnings(out.warnings)
      onLinked(out.link, out.warnings)

      // Verify rather than assert: a link that pushes nothing is not "set up".
      try {
        const res = await syncMondayNow(jwt, projectId)
        if (!aliveRef.current) return
        setPushNotice(
          res.ok && res.pushed
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
      setStage("confirm")
    }
  }, [
    jwt, newBoard, boardId, boardName, madeBoard, projectId, typedBoardName, newSelected, selected, rows,
    analysis, granularity, structure, onLinked, t,
  ])

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

  const boardUrl = linkedBoardUrl ?? structure?.url ?? analysis?.boardUrl ?? null
  const stepNumber = STEP_NUMBER[stage]
  const title =
    stage === "done"
      ? pushNotice?.ok && linkWarnings.length === 0 && notAdded.length === 0
        ? "Monday.com is set up"
        : t("projectSettings.monday.wizardDoneNeedsAttentionTitle")
      : stage === "board"
        ? t("projectSettings.monday.wizardBoardTitle")
        : stage === "columns"
          ? t("projectSettings.monday.wizardColumnsTitle")
          : stage === "confirm"
            ? t("projectSettings.monday.wizardConfirmTitle")
            : "Set up Monday.com with AI"
  const perFile = granularity === "file"

  const boardSelect = (
    <Select
      items={Object.fromEntries(boards_.map((b) => [b.id, b.name]))}
      value={boardId || null}
      onValueChange={(value) => {
        const id = (value as string) ?? ""
        setNewBoard(false)
        if (!id || id === boardId) return
        if (manual) setBoardId(id)
        else void runScan(id)
      }}
    >
      <SelectTrigger aria-label={t("projectSettings.monday.boardSelectAriaLabel")} className="w-full">
        <SelectValue placeholder={t("projectSettings.monday.pickBoardPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {boards_.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
              {b.workspace?.name ? ` — ${b.workspace.name}` : ""}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )

  return (
    // A click outside never closes the setup: a double-click on the button
    // that opened it, or on Next, would land on the backdrop and throw the
    // scan away. Escape and the X still close it.
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="max-w-xl" data-testid="monday-setup-wizard">
        <DialogHeader>
          {stepNumber != null && (
            <p className="text-xs text-muted-foreground">
              {t("projectSettings.monday.wizardStepOf", { step: stepNumber, total: 3 })}
            </p>
          )}
          <DialogTitle className="flex items-center gap-2">
            {stepNumber == null && <Sparkles className="h-4 w-4 text-primary" />}
            {title}
          </DialogTitle>
          {stage === "intro" && <DialogDescription>{t("projectSettings.monday.wizardIntroLine")}</DialogDescription>}
        </DialogHeader>

        {stage === "intro" && error && <p className="text-sm text-destructive">{error}</p>}

        {stage === "connect" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("projectSettings.monday.connectGateDescription")}</p>
            {awaitingOAuth && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" /> {t("projectSettings.monday.waitingForMonday")}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "scanning" && (
          <ul className="space-y-2 py-2" data-testid="monday-wizard-scan">
            <ScanStep state={scanDone >= 1 ? "done" : "running"} label={t("projectSettings.monday.scanStep1Label")} />
            <ScanStep
              state={scanDone >= 2 ? "done" : scanDone >= 1 ? "running" : "pending"}
              label={t("projectSettings.monday.scanStep2Label")}
            />
          </ul>
        )}

        {stage === "board" && (
          <div className="space-y-3" data-testid="monday-wizard-board">
            {noBoards && <p className="text-sm text-muted-foreground">{t("projectSettings.monday.noBoardsYet")}</p>}
            <RadioGroup
              name="monday-board-choice"
              value={newBoard ? "new" : "existing"}
              onValueChange={(value) => setNewBoard(value === "new")}
              className="flex flex-col gap-2"
            >
              {!noBoards && (
                <BoardChoice
                  value="existing"
                  selected={!newBoard}
                  label={manual ? t("projectSettings.monday.existingBoardOption") : existingBoardName}
                  help={manual ? undefined : analysis?.boardReason || undefined}
                  aside={
                    !manual && !changingBoard ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setNewBoard(false)
                          setChangingBoard(true)
                          void loadBoards()
                        }}
                      >
                        {t("org.projectOverview.change")}
                      </Button>
                    ) : undefined
                  }
                >
                  {(manual || changingBoard) &&
                    (boards === null ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner className="h-4 w-4" /> {t("projectSettings.monday.loadingBoards")}
                      </p>
                    ) : boards.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("projectSettings.monday.boardListFailed")}</p>
                    ) : (
                      boardSelect
                    ))}
                </BoardChoice>
              )}
              <BoardChoice
                value="new"
                selected={newBoard}
                label={t("projectSettings.monday.newBoardOption")}
                help={t("projectSettings.monday.newBoardHelp")}
              >
                {newBoard && (
                  <Input
                    id="monday-new-board-name"
                    aria-label={t("projectSettings.monday.newBoardNameLabel")}
                    value={newBoardName}
                    maxLength={255}
                    onChange={(e) => setNewBoardName(e.target.value)}
                    data-testid="monday-new-board-name"
                  />
                )}
              </BoardChoice>
            </RadioGroup>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "columns" && (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-testid="monday-wizard-columns">
            <MondayColumnChooser
              rows={chooserRows}
              boardColumns={chooserColumns}
              boardName={boardName}
              selected={ticks}
              onChange={setTicks}
            />

            {!newBoard && analysis && analysis.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {t("projectSettings.monday.someColumnsSkipped")}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {analysis.warnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? t("projectSettings.monday.wizardAdvancedHide") : t("projectSettings.monday.wizardAdvancedShow")}
            </button>
            {advanced && (
              <div className="space-y-3" data-testid="monday-wizard-advanced">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">{t("projectSettings.monday.boardItemsLabel")}</p>
                  <Select
                    items={{
                      project: t("projectSettings.monday.granularityProjectLabel"),
                      file: t("projectSettings.monday.granularityFileLabel"),
                    }}
                    value={granularity}
                    onValueChange={(value) => setGranularity((value as MondayMapping["itemGranularity"]) ?? "project")}
                  >
                    <SelectTrigger aria-label={t("projectSettings.monday.boardItemsLabel")} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="project">{t("projectSettings.monday.granularityProjectLabel")}</SelectItem>
                        <SelectItem value="file">{t("projectSettings.monday.granularityFileLabel")}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                {!newBoard && (
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">{t("projectSettings.monday.reviewRowsCaption")}</p>
                    <MondayMappingRows rows={rows} structure={structure} disabled={false} onChange={handleAdvancedRows} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {stage === "confirm" && (
          <div className="space-y-3" data-testid="monday-wizard-confirm">
            <p className="text-sm">
              {newBoard
                ? t(
                    perFile
                      ? "projectSettings.monday.wizardConfirmNewBoardPerFile"
                      : "projectSettings.monday.wizardConfirmNewBoard",
                    { count: adds, board: boardName },
                  )
                : adds > 0
                ? t(
                    perFile ? "projectSettings.monday.wizardConfirmAddsPerFile" : "projectSettings.monday.wizardConfirmAdds",
                    { count: adds },
                  )
                : t(
                    perFile ? "projectSettings.monday.wizardConfirmNoAddsPerFile" : "projectSettings.monday.wizardConfirmNoAdds",
                    { board: boardName },
                  )}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "applying" && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />{" "}
            {applyStep === "making"
              ? t("projectSettings.monday.wizardMakingBoard")
              : applyStep === "adding"
                ? t("projectSettings.monday.wizardAddingColumns")
                : t("projectSettings.monday.applyingStatus")}
          </p>
        )}

        {stage === "done" && (
          <div className="space-y-3" data-testid="monday-wizard-done">
            <p className="text-sm">
              {linkedBoardName ? `This project now syncs to ${linkedBoardName}.` : "This project now syncs to Monday."}{" "}
              {t("projectSettings.monday.progressPushesAutomatically")}
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
            {notAdded.length > 0 && (
              <p
                role="alert"
                data-testid="monday-wizard-not-added"
                className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-500"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {t("projectSettings.monday.wizardSomeColumnsNotAdded", {
                  columns: notAdded.map((f) => f.title).join(", "),
                  reason: notAdded[0]?.error ?? "",
                })}
              </p>
            )}
            {linkWarnings.length > 0 && (
              <div
                role="alert"
                data-testid="monday-wizard-link-warnings"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
              >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {t("projectSettings.monday.wizardLinkWarningsTitle")}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {linkWarnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              </div>
            )}
            {boardUrl && (
              <a
                href={boardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
              >
                {t("projectSettings.monday.viewBoardLink")} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {!boardUrl && (
              <p className="text-sm text-muted-foreground">
                {t("projectSettings.monday.wizardFindBoardManually", { name: linkedBoardName ?? boardId })}
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {stage === "intro" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
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
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void handleConnect()} disabled={busy || orgId == null}>
                {busy && <Spinner data-icon="inline-start" />}
                {t("projectSettings.monday.connectButton")}
              </Button>
            </>
          )}
          {stage === "board" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void goToColumns()} disabled={(newBoard ? !newBoardName.trim() : !boardId) || busy}>
                {busy && <Spinner data-icon="inline-start" />}
                {t("common.next")}
              </Button>
            </>
          )}
          {stage === "columns" && (
            <>
              <Button variant="ghost" onClick={() => setStage("board")}>
                {t("common.back")}
              </Button>
              <Button onClick={() => setStage("confirm")} disabled={!pickedBeyondId}>
                {t("common.next")}
              </Button>
            </>
          )}
          {stage === "confirm" && (
            <>
              <Button variant="ghost" onClick={() => setStage("columns")}>
                {t("common.back")}
              </Button>
              <Button onClick={() => void handleConfirm()}>
                {newBoard
                  ? t("projectSettings.monday.wizardMakeBoardButton")
                  : adds > 0
                  ? t("projectSettings.monday.wizardAddAndConnectButton")
                  : t("projectSettings.advancedLlm.connectButton")}
              </Button>
            </>
          )}
          {stage === "done" && (
            <>
              <Button variant="ghost" onClick={() => void handleUndo()} disabled={busy}>
                {busy && <Spinner data-icon="inline-start" />}
                {t("nav.renameSuggestions.undo")}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
