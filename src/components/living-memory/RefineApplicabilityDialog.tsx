/**
 * Agent-proposed applicability refinement, human-confirmed (AQU-934 phase 3c).
 *
 * Sibling of `RuleApplicabilityDialog` (the manual editor) and deliberately
 * shares its vocabulary: the same target-type and relationship labels name the
 * same things. Here the targets are PROPOSED — the refiner inspects the chosen
 * scope's segments, coalesces the verdicts into the fewest rows that express
 * them, and this dialog shows them for a verdict. Nothing is written until
 * someone confirms, and what is written is `assignedBy: "human"`: a person
 * confirming a mapping is the reusable evidence, not the model's guess.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount, formatPercent } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CompletionSettings } from "@/lib/parsers/types"
import { buildApplicabilityIndex } from "@/lib/rules/applicability"
import {
  MAX_CELLS_PER_RUN,
  refineApplicability,
  type ProposedApplicability,
  type ProposedRelationship,
  type RefinerCell,
} from "@/lib/rules/applicability-refiner"
import type {
  ApplicabilityTargetType,
  CellCoordinates,
  RuleApplicability,
  StyleRule,
  UpsertApplicabilityInput,
} from "@/lib/rules/style-rule-types"

/** Same keys the manual editor uses — one vocabulary for both surfaces. */
const TARGET_LABEL_KEY: Record<ApplicabilityTargetType, MessageKey> = {
  genre: "terminology.livingMemory.styleRules.scope.genre",
  book: "terminology.livingMemory.styleRules.target.book",
  file: "common.file",
  section: "terminology.livingMemory.styleRules.scope.section",
  passage: "terminology.livingMemory.styleRules.scope.passage",
  segment: "terminology.livingMemory.styleRules.scope.segment",
}

const RELATIONSHIP_LABEL_KEY: Record<ProposedRelationship, MessageKey> = {
  applies: "terminology.livingMemory.styleRules.relationship.applies",
  excluded: "terminology.livingMemory.styleRules.relationship.excluded",
}

/** Review order: what the rule gains, then what it gives up. */
const RELATIONSHIP_ORDER: readonly ProposedRelationship[] = ["applies", "excluded"]

/** Sentinel scope value — Base UI reads "" as "nothing selected". */
const WHOLE_PROJECT = "__project"

/** One file offered in the scope picker. */
export interface RefineScopeFile {
  id: string
  name: string
}

/** A segment to inspect, carrying the coordinates the resolver matches on. */
export interface RefineSegment extends RefinerCell {
  coords: CellCoordinates
}

type Phase = "pick" | "running" | "review"

function proposalKey(row: ProposedApplicability): string {
  return `${row.targetType} ${row.targetId} ${row.relationship}`
}

interface RefineApplicabilityDialogProps {
  /** Null keeps the dialog closed — the library row supplies the open rule. */
  rule: StyleRule | null
  files: readonly RefineScopeFile[]
  /** Loads the segments to inspect; `null` means the whole project. */
  loadSegments?: (fileId: string | null, signal: AbortSignal) => Promise<readonly RefineSegment[]>
  /** Every applicability row in the project — proposals dedupe against these. */
  rows: readonly RuleApplicability[]
  settings?: CompletionSettings
  session: FrontierSession | null
  canManage: boolean
  onClose: () => void
  /** Confirmed rows, ready for `setApplicability`. Never called empty. */
  onConfirm: (rows: UpsertApplicabilityInput[]) => void
}

export function RefineApplicabilityDialog({
  rule,
  files,
  loadSegments,
  rows,
  settings,
  session,
  canManage,
  onClose,
  onConfirm,
}: RefineApplicabilityDialogProps) {
  const t = useT()
  const { locale } = useI18n()
  const [scope, setScope] = useState<string>(WHOLE_PROJECT)
  const [phase, setPhase] = useState<Phase>("pick")
  const [progress, setProgress] = useState({ inspected: 0, total: 0, matched: 0 })
  const [truncated, setTruncated] = useState(false)
  const [proposals, setProposals] = useState<ProposedApplicability[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const ruleId = rule?.id ?? null
  useEffect(() => {
    // Opening on another rule must not inherit the previous rule's proposals,
    // and closing mid-run must stop the walk.
    abortRef.current?.abort()
    abortRef.current = null
    setPhase("pick")
    setScope(WHOLE_PROJECT)
    setProgress({ inspected: 0, total: 0, matched: 0 })
    setTruncated(false)
    setProposals([])
    setSelected(new Set())
    setError(null)
  }, [ruleId])

  const ruleRows = useMemo(
    () => rows.filter((row) => row.ruleId === ruleId),
    [rows, ruleId],
  )

  if (!rule) return null

  const canStart = Boolean(loadSegments && settings)
  const scopeItems = {
    [WHOLE_PROJECT]: t("terminology.livingMemory.styleRules.refine.scopeProject"),
    ...Object.fromEntries(files.map((file) => [file.id, file.name])),
  }

  async function run() {
    if (!rule || !loadSegments || !settings) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase("running")
    setError(null)
    setProposals([])
    setTruncated(false)
    setProgress({ inspected: 0, total: 0, matched: 0 })
    try {
      const segments = await loadSegments(scope === WHOLE_PROJECT ? null : scope, controller.signal)
      setTruncated(segments.length > MAX_CELLS_PER_RUN)
      const coords = new Map(segments.map((segment) => [segment.id, segment.coords]))
      const proposed = await refineApplicability({
        rule,
        cells: segments,
        coordsFor: (cell) => coords.get(cell.id) ?? { segment: cell.id },
        existingIndex: buildApplicabilityIndex([...ruleRows]),
        settings,
        session,
        signal: controller.signal,
        onProgress: (inspected, total, matched) => setProgress({ inspected, total, matched }),
      })
      setProposals(proposed)
      setSelected(new Set(proposed.map(proposalKey)))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err))
    } finally {
      abortRef.current = null
      setPhase("review")
    }
  }

  function confirm() {
    const confirmed = proposals
      .filter((row) => selected.has(proposalKey(row)))
      .map<UpsertApplicabilityInput>((row) => ({
        targetType: row.targetType,
        targetId: row.targetId,
        relationship: row.relationship,
        assignedBy: "human",
        ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      }))
    if (confirmed.length > 0) onConfirm(confirmed)
    close()
  }

  function close() {
    abortRef.current?.abort()
    onClose()
  }

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const groups = RELATIONSHIP_ORDER.map((relationship) => ({
    relationship,
    rows: proposals.filter((row) => row.relationship === relationship),
  })).filter((group) => group.rows.length > 0)

  const truncationNote = truncated ? (
    <p className="text-xs text-muted-foreground/70">
      {t("terminology.livingMemory.styleRules.refine.truncated", {
        count: formatCount(MAX_CELLS_PER_RUN, locale),
      })}
    </p>
  ) : null

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) close() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("terminology.livingMemory.styleRules.refine.title")}</DialogTitle>
          <DialogDescription>{rule.instruction}</DialogDescription>
        </DialogHeader>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("terminology.livingMemory.styleRules.refine.description")}
        </p>

        {phase === "pick" ? (
          <Field>
            <FieldLabel htmlFor="refine-scope">
              {t("terminology.livingMemory.styleRules.refine.scopeLabel")}
            </FieldLabel>
            <Select
              items={scopeItems}
              value={scope}
              onValueChange={(value) => setScope(String(value ?? WHOLE_PROJECT))}
            >
              <SelectTrigger id="refine-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={WHOLE_PROJECT}>
                    {t("terminology.livingMemory.styleRules.refine.scopeProject")}
                  </SelectItem>
                  {files.map((file) => (
                    <SelectItem key={file.id} value={file.id}>
                      {file.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {phase === "pick" && !canStart ? (
          <p className="text-xs text-muted-foreground">
            {t("terminology.livingMemory.styleRules.refine.needsModel")}
          </p>
        ) : null}

        {phase === "running" ? (
          <div className="flex flex-col gap-1" role="status">
            <p className="text-xs text-muted-foreground">
              {t("terminology.livingMemory.styleRules.refine.progress", {
                current: formatCount(progress.inspected, locale),
                total: formatCount(progress.total, locale),
              })}
            </p>
            <p className="text-xs text-muted-foreground/70">
              {t("terminology.livingMemory.styleRules.refine.matched", {
                count: formatCount(progress.matched, locale),
              })}
            </p>
            {truncationNote}
          </div>
        ) : null}

        {phase === "review" && !error ? (
          <div className="flex flex-col gap-3">
            {truncationNote}
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t("terminology.livingMemory.styleRules.refine.none")}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setSelected(new Set(proposals.map(proposalKey)))}
                  >
                    {t("common.selectAll")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={() => setSelected(new Set())}
                  >
                    {t("common.clear")}
                  </Button>
                </div>
                {groups.map((group) => (
                  <div key={group.relationship} className="flex flex-col gap-1.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      {t(RELATIONSHIP_LABEL_KEY[group.relationship])}
                    </h4>
                    <ul className="flex flex-col gap-1.5">
                      {group.rows.map((row) => {
                        const key = proposalKey(row)
                        return (
                          <li
                            key={key}
                            className="flex items-start gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                          >
                            <Checkbox
                              className="mt-1"
                              checked={selected.has(key)}
                              onCheckedChange={() => toggle(key)}
                              aria-label={t(
                                "terminology.livingMemory.styleRules.refine.includeAria",
                                { target: row.targetId },
                              )}
                            />
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs text-muted-foreground">
                                  {t(TARGET_LABEL_KEY[row.targetType])}
                                </span>
                                <span className="text-sm font-medium">{row.targetId}</span>
                                <Badge variant="outline" className="tabular-nums">
                                  {t("terminology.livingMemory.styleRules.refine.coverage", {
                                    count: formatCount(row.coveredCellIds.length, locale),
                                  })}
                                </Badge>
                                {row.confidence !== undefined ? (
                                  <Badge variant="ghost" className="tabular-nums">
                                    {t("terminology.livingMemory.styleRules.refine.confidence", {
                                      percent: formatPercent(row.confidence, locale),
                                    })}
                                  </Badge>
                                ) : null}
                              </div>
                              {row.reason ? (
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                  {row.reason}
                                </p>
                              ) : null}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 text-xs text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              {t("terminology.livingMemory.styleRules.refine.failed", { message: error })}
            </span>
          </div>
        ) : null}

        <DialogFooter>
          {phase === "running" ? (
            <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
              {t("common.cancel")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={close}>
              {phase === "review" ? t("common.discard") : t("common.cancel")}
            </Button>
          )}
          {phase === "pick" ? (
            <Button disabled={!canStart} onClick={() => void run()}>
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {t("terminology.livingMemory.styleRules.refine.start")}
            </Button>
          ) : null}
          {phase === "review" && groups.length > 0 ? (
            <Button disabled={!canManage || selected.size === 0} onClick={confirm}>
              {t("terminology.livingMemory.styleRules.refine.confirm", {
                count: formatCount(selected.size, locale),
              })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
