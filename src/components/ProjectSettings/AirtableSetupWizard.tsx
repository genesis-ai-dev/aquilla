// Airtable table setup (AQU-804): Monday's three short steps
// (MondaySetupWizard) for a table.
//
//   intro → [connect] → scanning → 1 table → 2 fields → 3 confirm → applying → done
//
//   1. Which table? The AI's pick (and why) across the bases the token sees,
//      with a way to change it.
//   2. What should your table show? The same field list as Monday's columns,
//      with the recommended ones and anything already in the table ticked.
//      Names (Translators, Project manager) stay unticked unless the table
//      already has them, as on Monday.
//   3. Confirm, with one button that says what happens.
//
// Nothing is written to Airtable before step 3: fields are created only on
// confirm, then mapped, linked and pushed, and "set up" is only claimed after
// a real push. Connecting is pasting a personal access token, so the connect
// step is inline instead of a trip to another tab. The manual path (mode
// "manual") is the same flow without the AI.

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
import { SearchSelect } from "@/components/ui/search-select"
import { Spinner } from "@/components/ui/spinner"
import {
  addAirtableFields,
  analyzeAirtableMapping,
  deleteAirtableLink,
  fetchAirtableBases,
  fetchAirtableTables,
  putAirtableLink,
  syncAirtableNow,
  toBoardStructure,
  type AirtableAnalysis,
  type AirtableBase,
  type AirtableTable,
  type AirtableTableLink,
} from "@/lib/airtable/api"
import type { MondayAddColumnsResult, MondayBoardStructure } from "@/lib/monday/api"
import { AIRTABLE_COLUMN_PROFILE, type AirtableMapping, type AirtableRowGranularity } from "@/lib/airtable/types"
import { AIRTABLE_CHOOSER_COPY, AIRTABLE_MAPPING_COPY } from "@/lib/airtable/ui-copy"
import type { MondayColumnMapping, MondayMetricKey } from "@/lib/monday/types"
import {
  REQUIRED_METRIC,
  columnSelectionCounts,
  initialColumnSelection,
  metricsToAdd,
  selectedRows,
} from "@/lib/monday/column-selection"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useT } from "@/lib/i18n/I18nProvider"
import { MondayMappingRows } from "./MondayMappingEditor"
import { MondayColumnChooser } from "./MondayColumnChooser"
import { AirtableTokenForm } from "./AirtableTokenForm"

type Stage = "intro" | "connect" | "scanning" | "table" | "columns" | "confirm" | "applying" | "done"

const GRANULARITY_LABEL: Record<AirtableRowGranularity, MessageKey> = {
  project: "projectSettings.airtable.granularity.project",
  file: "projectSettings.airtable.granularity.file",
  project_and_files: "projectSettings.airtable.granularity.projectAndFiles",
}

const CONFIRM_RECORDS: Record<AirtableRowGranularity, MessageKey> = {
  project: "projectSettings.airtable.wizardConfirmRecords.project",
  file: "projectSettings.airtable.wizardConfirmRecords.file",
  project_and_files: "projectSettings.airtable.wizardConfirmRecords.projectAndFiles",
}

/** The table a setup is aimed at, with its base. */
interface Target {
  baseId: string
  baseName: string | null
  tableId: string
  tableName: string
  url: string | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  orgId: number | null
  jwt: string | null
  /** Whether the org already holds an Airtable connection. */
  orgConnected: boolean
  /** "manual": the user picks the table and nothing is asked of the AI. */
  mode?: "ai" | "manual"
  /** A link was created; the parent shows it, with the server's warnings. */
  onLinked: (link: AirtableTableLink, warnings: string[]) => void
  /** The wizard's Undo removed the link it had just created. */
  onUnlinked: () => void
  /** A token was pasted in the connect step; the parent refetches the connection. */
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

const STEP_NUMBER: Partial<Record<Stage, number>> = { table: 1, columns: 2, confirm: 3 }

export function AirtableSetupWizard({
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

  const [analysis, setAnalysis] = useState<AirtableAnalysis | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [structure, setStructure] = useState<MondayBoardStructure | null>(null)
  const [rows, setRows] = useState<MondayColumnMapping[]>([])
  const [granularity, setGranularity] = useState<AirtableRowGranularity>("project_and_files")
  const [selected, setSelected] = useState<Set<MondayMetricKey>>(new Set([REQUIRED_METRIC]))
  const [advanced, setAdvanced] = useState(false)
  const [scanDone, setScanDone] = useState(0)

  // The base and table pickers (the manual path's step 1, and "Change").
  const [bases, setBases] = useState<AirtableBase[] | null>(null)
  const [baseId, setBaseId] = useState("")
  const [tables, setTables] = useState<AirtableTable[] | null>(null)
  const [changing, setChanging] = useState(false)

  const [applyStep, setApplyStep] = useState<"adding" | "linking">("linking")
  const [notAdded, setNotAdded] = useState<MondayAddColumnsResult["failed"]>([])
  const [pushNotice, setPushNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [linkWarnings, setLinkWarnings] = useState<string[]>([])
  const [linked, setLinked] = useState<AirtableTableLink | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Reset every time the dialog is opened, so a previous run never greets the next.
  useEffect(() => {
    if (!open) return
    setStage(manual ? (orgConnected ? "table" : "connect") : "intro")
    setError(null)
    setAnalysis(null)
    setTarget(null)
    setStructure(null)
    setRows([])
    setGranularity("project_and_files")
    setSelected(new Set([REQUIRED_METRIC]))
    setAdvanced(false)
    setScanDone(0)
    setBases(null)
    setBaseId("")
    setTables(null)
    setChanging(false)
    setNotAdded([])
    setPushNotice(null)
    setLinkWarnings([])
    setLinked(null)
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadBases = useCallback(async () => {
    if (bases !== null || !jwt || orgId == null) return
    try {
      const got = await fetchAirtableBases(jwt, orgId)
      if (aliveRef.current) setBases(got)
    } catch {
      // Listing needs org maintainer; without it the AI's pick stands.
      if (aliveRef.current) setBases([])
    }
  }, [bases, jwt, orgId])

  const pickBase = useCallback(
    async (id: string) => {
      setBaseId(id)
      setTables(null)
      if (!jwt || orgId == null || !id) return
      try {
        const got = await fetchAirtableTables(jwt, orgId, id)
        if (aliveRef.current) setTables(got)
      } catch {
        if (aliveRef.current) setTables([])
      }
    },
    [jwt, orgId],
  )

  useEffect(() => {
    if (open && manual && stage === "table") void loadBases()
  }, [open, manual, stage, loadBases])

  // ── Scan (AI path): one analyze call; it returns the table it chose ──────
  const runScan = useCallback(
    async (pick?: { baseId: string; tableId: string; baseName?: string }) => {
      if (!jwt) return
      setStage("scanning")
      setError(null)
      setScanDone(0)
      setChanging(false)
      try {
        const got = await analyzeAirtableMapping(jwt, projectId, pick ?? {})
        if (!aliveRef.current) return
        setScanDone(1)
        const built = toBoardStructure(got.structure)
        setAnalysis(got)
        setTarget({
          baseId: got.structure.baseId,
          baseName: got.structure.baseName ?? pick?.baseName ?? null,
          tableId: got.structure.tableId,
          tableName: got.structure.tableName ?? got.structure.tableId,
          url: got.structure.url,
        })
        setStructure(built)
        setRows(got.proposal.columns)
        setGranularity(got.proposal.itemGranularity)
        setSelected(initialColumnSelection(got.proposal.columns, built.columns, { recommend: true }, AIRTABLE_COLUMN_PROFILE))
        setScanDone(2)
        setStage("table")
      } catch (e) {
        if (!aliveRef.current) return
        setError(errMsg(e))
        setStage("intro")
      }
    },
    [jwt, projectId],
  )

  const handleStart = useCallback(() => {
    if (!orgConnected) {
      setStage("connect")
      return
    }
    void runScan()
  }, [orgConnected, runScan])

  // ── Step 1 → 2 ───────────────────────────────────────────────────────────
  const chosenTable = tables?.find((tb) => tb.id === target?.tableId) ?? null
  const goToColumns = useCallback(() => {
    if (manual) {
      // No AI: tick what's already in the table plus the recommended set.
      if (!chosenTable) return
      const built = toBoardStructure(chosenTable)
      setStructure(built)
      setRows([])
      setSelected(initialColumnSelection([], built.columns, { recommend: true }, AIRTABLE_COLUMN_PROFILE))
    }
    setError(null)
    setStage("columns")
  }, [manual, chosenTable])

  const handleAdvancedRows = useCallback((next: MondayColumnMapping[]) => {
    setRows(next)
    setSelected((prev) => {
      const out = new Set(prev)
      for (const r of next) if (r.columnId) out.add(r.metric)
      return out
    })
  }, [])

  // ── Step 3: create the new fields, then link and prove it by pushing ─────
  const tableName = target?.tableName ?? ""
  const { adds } = columnSelectionCounts(selected, rows, structure?.columns, AIRTABLE_COLUMN_PROFILE)
  const pickedBeyondId = [...selected].some((m) => m !== REQUIRED_METRIC)

  const handleConfirm = useCallback(async () => {
    if (!jwt || !target) return
    setStage("applying")
    setError(null)
    setNotAdded([])

    let added: MondayAddColumnsResult | null = null
    const need = metricsToAdd(selected, rows, AIRTABLE_COLUMN_PROFILE)
    if (need.length > 0) {
      setApplyStep("adding")
      try {
        added = await addAirtableFields(jwt, projectId, { baseId: target.baseId, tableId: target.tableId, metrics: need })
        if (!aliveRef.current) return
        setStructure(added.structure)
        setNotAdded(added.failed)
      } catch (e) {
        if (!aliveRef.current) return
        setError(t("projectSettings.airtable.wizardAddFieldsFailed", { reason: errMsg(e) }))
        setStage("confirm")
        return
      }
    }
    setApplyStep("linking")

    // A name template the AI wrote for another granularity no longer fits.
    const proposal = analysis?.proposal
    const keepTemplate = proposal && granularity === proposal.itemGranularity ? proposal.itemNameTemplate : undefined
    const config: AirtableMapping = {
      version: 1,
      tableId: target.tableId,
      itemGranularity: granularity,
      ...(keepTemplate ? { itemNameTemplate: keepTemplate } : {}),
      ...(proposal?.notes ? { notes: proposal.notes } : {}),
      columns: selectedRows(rows, selected, added, AIRTABLE_COLUMN_PROFILE),
    }

    try {
      const out = await putAirtableLink(jwt, projectId, {
        baseId: target.baseId,
        tableId: target.tableId,
        ...(target.baseName ? { baseName: target.baseName } : {}),
        config,
      })
      if (!aliveRef.current) return
      setLinked(out.link)
      setLinkWarnings(out.warnings)
      onLinked(out.link, out.warnings)

      // Verify rather than assert: a link that pushes nothing is not "set up".
      try {
        const res = await syncAirtableNow(jwt, projectId)
        if (!aliveRef.current) return
        setPushNotice(
          res.ok && res.pushed
            ? { ok: true, text: t("projectSettings.airtable.pushedRecords", { count: res.itemsUpserted ?? 0 }) }
            : { ok: false, text: res.error ?? t("error.airtable.sync") },
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
  }, [jwt, target, selected, rows, projectId, analysis, granularity, onLinked, t])

  const handleUndo = useCallback(async () => {
    if (!jwt) return
    setBusy(true)
    try {
      await deleteAirtableLink(jwt, projectId)
      if (!aliveRef.current) return
      onUnlinked()
      onOpenChange(false)
    } catch (e) {
      if (aliveRef.current) setError(errMsg(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }, [jwt, projectId, onUnlinked, onOpenChange])

  const stepNumber = STEP_NUMBER[stage]
  const title =
    stage === "done"
      ? pushNotice?.ok && linkWarnings.length === 0 && notAdded.length === 0
        ? t("projectSettings.airtable.wizardDoneTitle")
        : t("projectSettings.airtable.wizardDoneNeedsAttentionTitle")
      : stage === "table"
        ? t("projectSettings.airtable.wizardTableTitle")
        : stage === "columns"
          ? t("projectSettings.airtable.wizardColumnsTitle")
          : stage === "confirm"
            ? t("projectSettings.monday.wizardConfirmTitle")
            : t("projectSettings.airtable.wizardTitle")

  // Base, then table. Picking a table in the AI path asks the AI again.
  const pickers = (
    <div className="flex flex-col gap-2">
      {bases === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t("projectSettings.airtable.loadingBases")}
        </p>
      ) : bases.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("projectSettings.airtable.tableListFailed")}</p>
      ) : (
        // AQU-2260: an account's bases and a base's tables grow with its
        // data, so both lists have a search box.
        <SearchSelect
          aria-label={t("projectSettings.airtable.baseSelectAriaLabel")}
          className="w-full"
          options={bases.map((b) => ({ value: b.id, label: b.name }))}
          value={baseId || null}
          onValueChange={(value) => void pickBase(value)}
          placeholder={t("projectSettings.airtable.pickBasePlaceholder")}
        />
      )}
      {baseId &&
        (tables === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" /> {t("projectSettings.airtable.loadingTables")}
          </p>
        ) : (
<SearchSelect
            aria-label={t("projectSettings.airtable.tableSelectAriaLabel")}
            className="w-full"
            options={tables.map((tb) => ({ value: tb.id, label: tb.name }))}
            value={target?.baseId === baseId ? target.tableId : null}
            onValueChange={(value) => {
              const table = tables.find((tb) => tb.id === value)
              if (!table) return
              const baseName = bases?.find((b) => b.id === baseId)?.name ?? null
              if (manual) {
                setTarget({ baseId, baseName, tableId: table.id, tableName: table.name, url: table.url })
              } else {
                void runScan({ baseId, tableId: table.id, ...(baseName ? { baseName } : {}) })
              }
            }}
            placeholder={t("projectSettings.airtable.pickTablePlaceholder")}
          />
        ))}
    </div>
  )

  return (
    // A click outside never closes the setup (Monday's rule): a double-click
    // on the button that opened it would throw the scan away.
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent className="max-w-xl" data-testid="airtable-setup-wizard">
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
          {stage === "intro" && <DialogDescription>{t("projectSettings.airtable.wizardIntroLine")}</DialogDescription>}
        </DialogHeader>

        {stage === "intro" && error && <p className="text-sm text-destructive">{error}</p>}

        {stage === "connect" && (
          <div className="space-y-3" data-testid="airtable-wizard-connect">
            <p className="text-sm text-muted-foreground">{t("projectSettings.airtable.connectGateDescription")}</p>
            <AirtableTokenForm
              jwt={jwt}
              orgId={orgId}
              onConnected={() => {
                onConnected()
                if (manual) setStage("table")
                else void runScan()
              }}
            />
          </div>
        )}

        {stage === "scanning" && (
          <ul className="space-y-2 py-2" data-testid="airtable-wizard-scan">
            <ScanStep state={scanDone >= 1 ? "done" : "running"} label={t("projectSettings.airtable.scanStep1Label")} />
            <ScanStep
              state={scanDone >= 2 ? "done" : scanDone >= 1 ? "running" : "pending"}
              label={t("projectSettings.airtable.scanStep2Label")}
            />
          </ul>
        )}

        {stage === "table" && (
          <div className="space-y-3" data-testid="airtable-wizard-table">
            {manual ? (
              pickers
            ) : (
              <div className="rounded-lg border p-3">
                {!changing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium break-words">{tableName}</p>
                      {target?.baseName && (
                        <p className="text-xs text-muted-foreground">
                          {t("projectSettings.airtable.tableInBase", { base: target.baseName })}
                        </p>
                      )}
                      {analysis?.tableReason && <p className="text-xs text-muted-foreground">{analysis.tableReason}</p>}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setChanging(true)
                        void loadBases()
                      }}
                    >
                      {t("org.projectOverview.change")}
                    </Button>
                  </div>
                ) : (
                  pickers
                )}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "columns" && (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-testid="airtable-wizard-columns">
            <MondayColumnChooser
              rows={rows}
              boardColumns={structure?.columns}
              boardName={tableName}
              selected={selected}
              onChange={setSelected}
              profile={AIRTABLE_COLUMN_PROFILE}
              copy={AIRTABLE_CHOOSER_COPY}
              testIdPrefix="airtable"
            />

            {analysis && analysis.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {t("projectSettings.airtable.someFieldsSkipped")}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {analysis.warnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t("projectSettings.airtable.recordsLabel")}</p>
              <Select
                items={Object.fromEntries(
                  (Object.keys(GRANULARITY_LABEL) as AirtableRowGranularity[]).map((g) => [g, t(GRANULARITY_LABEL[g])]),
                )}
                value={granularity}
                onValueChange={(value) => setGranularity((value as AirtableRowGranularity) ?? "project_and_files")}
              >
                <SelectTrigger aria-label={t("projectSettings.airtable.recordsLabel")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(GRANULARITY_LABEL) as AirtableRowGranularity[]).map((g) => (
                      <SelectItem key={g} value={g}>
                        {t(GRANULARITY_LABEL[g])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? t("projectSettings.monday.wizardAdvancedHide") : t("projectSettings.airtable.wizardAdvancedShow")}
            </button>
            {advanced && (
              <div data-testid="airtable-wizard-advanced">
                <p className="mb-1 text-xs text-muted-foreground">{t("projectSettings.monday.reviewRowsCaption")}</p>
                <MondayMappingRows
                  rows={rows}
                  structure={structure}
                  disabled={false}
                  onChange={handleAdvancedRows}
                  copy={AIRTABLE_MAPPING_COPY}
                  readOnlyTypes={AIRTABLE_COLUMN_PROFILE.readOnlyTypes}
                />
              </div>
            )}
          </div>
        )}

        {stage === "confirm" && (
          <div className="space-y-3" data-testid="airtable-wizard-confirm">
            <p className="text-sm">
              {adds > 0
                ? t("projectSettings.airtable.wizardConfirmAdds", { count: adds, table: tableName })
                : t("projectSettings.airtable.wizardConfirmNoAdds", { table: tableName })}{" "}
              {t(CONFIRM_RECORDS[granularity])}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        {stage === "applying" && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />{" "}
            {applyStep === "adding"
              ? t("projectSettings.airtable.wizardAddingFields")
              : t("projectSettings.airtable.applyingStatus")}
          </p>
        )}

        {stage === "done" && (
          <div className="space-y-3" data-testid="airtable-wizard-done">
            <p className="text-sm">
              {t("projectSettings.airtable.wizardDoneLine", { table: linked?.tableName ?? tableName })}{" "}
              {t("projectSettings.monday.progressPushesAutomatically")}
            </p>
            {pushNotice && (
              <p
                className={
                  pushNotice.ok
                    ? "flex items-center gap-1.5 text-sm text-muted-foreground"
                    : "flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-500"
                }
                data-testid="airtable-wizard-push"
              >
                {pushNotice.ok ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                {pushNotice.ok
                  ? pushNotice.text
                  : t("projectSettings.airtable.firstPushFailed", { reason: pushNotice.text })}
              </p>
            )}
            {notAdded.length > 0 && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-500">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {t("projectSettings.airtable.wizardSomeFieldsNotAdded", {
                  columns: notAdded.map((f) => f.title).join(", "),
                  reason: notAdded[0]?.error ?? "",
                })}
              </p>
            )}
            {linkWarnings.length > 0 && (
              <div
                role="alert"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40"
              >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  {t("projectSettings.airtable.wizardLinkWarningsTitle")}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {linkWarnings.map((w) => (
                    <li key={w}>· {w}</li>
                  ))}
                </ul>
              </div>
            )}
            {(linked?.tableUrl ?? target?.url) && (
              <a
                href={linked?.tableUrl ?? target?.url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
              >
                {t("projectSettings.airtable.openTable")} <ExternalLink className="h-3.5 w-3.5" />
              </a>
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
                {orgConnected ? t("projectSettings.airtable.scanButton") : t("projectSettings.airtable.connectAndScanButton")}
              </Button>
            </>
          )}
          {stage === "connect" && (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
          )}
          {stage === "table" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={goToColumns} disabled={!target || (manual && !chosenTable) || busy}>
                {t("common.next")}
              </Button>
            </>
          )}
          {stage === "columns" && (
            <>
              <Button variant="ghost" onClick={() => setStage("table")}>
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
                {adds > 0
                  ? t("projectSettings.airtable.wizardAddAndConnectButton")
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
