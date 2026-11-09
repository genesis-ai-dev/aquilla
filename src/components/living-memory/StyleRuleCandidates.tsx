/**
 * Review queue for extracted style rules (AQU-934 phase 2).
 *
 * Every proposed rule carries its citation back to the knowledge-base section
 * it came from, so a reviewer can judge it without leaving the pane. Editing is
 * deliberately NOT an approval: `updateRule` only PATCHes the wording and
 * classification, leaving the rule `proposed` until someone approves it.
 *
 * AQU-2366: an extraction pass proposes everything it found at once, so the
 * queue is **batched** — `BATCH_SIZE` proposals are visible, the rest arrive
 * through "Show {count} more". Deciding on the visible batch uncovers the next
 * one on its own, because a reviewed rule leaves `proposed` and drops out of
 * `rules`. "Dismiss the remaining N" clears everything past the visible batch
 * in one action, and is reversible because it is *staged*, not sent: the
 * `reject` calls only leave for the server when the undo window closes, so
 * "Undo" is a local cancel. That matters — the server lets a rule leave
 * `proposed` exactly once (`reviewRule` in `db/shared/style-rules.ts` refuses
 * any rule that is not `proposed`), so a dismissal that reached it could not be
 * taken back. Unmounting inside the window cancels the dismissal rather than
 * committing it: the proposals stay `proposed`, which is the safe direction.
 */

import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatCount } from "@/lib/i18n/format"
import type {
  StyleRule,
  StyleRuleCategory,
  UpdateStyleRuleInput,
} from "@/lib/rules/style-rule-types"
import type { StyleRuleLabels } from "./style-rule-labels"

const SEVERITIES: readonly StyleRule["severity"][] = ["minor", "major"]

/** How many proposals a reviewer sees at once (AQU-2366). */
const BATCH_SIZE = 10

/** How long a staged "dismiss the rest" can be taken back before it is sent. */
const UNDO_WINDOW_MS = 8000

// ── Edit dialog ────────────────────────────────────────────────────────────

interface EditDialogProps {
  rule: StyleRule | null
  labels: StyleRuleLabels
  onClose: () => void
  onSave: (id: string, patch: UpdateStyleRuleInput) => void
}

function CandidateEditDialog({ rule, labels, onClose, onSave }: EditDialogProps) {
  const t = useT()
  const [instruction, setInstruction] = useState(rule?.instruction ?? "")
  const [category, setCategory] = useState<StyleRuleCategory>(rule?.category ?? "other")
  const [severity, setSeverity] = useState<StyleRule["severity"]>(rule?.severity ?? "minor")
  const [conditions, setConditions] = useState(rule?.conditions ?? "")

  if (!rule) return null

  const categoryItems = Object.fromEntries(
    labels.categoryOrder.map((c) => [c, labels.category[c]]),
  )
  const severityItems = Object.fromEntries(SEVERITIES.map((s) => [s, labels.severity[s]]))

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("terminology.livingMemory.styleRules.candidates.editTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("terminology.livingMemory.styleRules.candidates.editDescription")}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="style-rule-instruction">
              {t("terminology.livingMemory.styleRules.field.instruction")}
            </FieldLabel>
            <Textarea
              id="style-rule-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={t(
                "terminology.livingMemory.styleRules.field.instructionPlaceholder",
              )}
              className="min-h-[72px]"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="style-rule-category">
                {t("terminology.livingMemory.styleRules.field.category")}
              </FieldLabel>
              <Select
                items={categoryItems}
                value={category}
                onValueChange={(value) => setCategory(value as StyleRuleCategory)}
              >
                <SelectTrigger id="style-rule-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {labels.categoryOrder.map((c) => (
                      <SelectItem key={c} value={c}>
                        {labels.category[c]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="style-rule-severity">
                {t("rules.editor.severityLabel")}
              </FieldLabel>
              <Select
                items={severityItems}
                value={severity}
                onValueChange={(value) => setSeverity(value as StyleRule["severity"])}
              >
                <SelectTrigger id="style-rule-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {labels.severity[s]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="style-rule-conditions">
              {t("terminology.livingMemory.styleRules.field.conditions")}
            </FieldLabel>
            <Input
              id="style-rule-conditions"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
              placeholder={t("terminology.livingMemory.styleRules.field.conditionsPlaceholder")}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!instruction.trim()}
            onClick={() => {
              onSave(rule.id, {
                instruction: instruction.trim(),
                category,
                severity,
                conditions: conditions.trim() || null,
              })
              onClose()
            }}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Queue ──────────────────────────────────────────────────────────────────

interface StyleRuleCandidatesProps {
  rules: StyleRule[]
  canReview: boolean
  labels: StyleRuleLabels
  /** docId → knowledge-document name, for the source citation. */
  docNames: Record<string, string>
  onReview: (id: string, action: "approve" | "reject") => void
  onSave: (id: string, patch: UpdateStyleRuleInput) => void
  /**
   * Rejects a whole staged batch. Separate from `onReview` so the caller can
   * walk the ids one at a time: a dismissal can carry dozens of rules, and
   * each verdict refetches the library.
   */
  onDismissMany: (ids: readonly string[]) => void
}

export function StyleRuleCandidates({
  rules,
  canReview,
  labels,
  docNames,
  onReview,
  onSave,
  onDismissMany,
}: StyleRuleCandidatesProps) {
  const t = useT()
  const { locale } = useI18n()
  const [editing, setEditing] = useState<StyleRule | null>(null)
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)
  // Ids staged for dismissal: already out of the queue, not yet rejected.
  const [staged, setStaged] = useState<readonly string[]>([])

  // Read through a ref so the undo window is not restarted by a parent that
  // passes a fresh `onDismissMany` identity on every render.
  const dismissRef = useRef(onDismissMany)
  useEffect(() => {
    dismissRef.current = onDismissMany
  }, [onDismissMany])

  useEffect(() => {
    if (staged.length === 0) return
    const ids = staged
    const timer = setTimeout(() => {
      setStaged([])
      dismissRef.current(ids)
    }, UNDO_WINDOW_MS)
    // Clearing on cleanup is deliberate: Undo and unmount both cancel.
    return () => clearTimeout(timer)
  }, [staged])

  const pending = rules.filter((rule) => !staged.includes(rule.id))
  const shown = pending.slice(0, visibleCount)
  const remaining = pending.length - shown.length

  if (pending.length === 0 && staged.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/60 italic">
        {t("terminology.livingMemory.styleRules.candidates.empty")}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {shown.map((rule) => {
        const source = rule.source
        const citation =
          source && source.kind === "knowledge-doc"
            ? { doc: docNames[source.docId] ?? source.docId, quote: source.quote }
            : null
        return (
          <Card key={rule.id} className="overflow-hidden">
            <CardContent className="flex flex-col gap-2 p-3">
              <p className="text-sm leading-relaxed">{rule.instruction}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{labels.category[rule.category]}</Badge>
                <Badge variant="outline">{labels.scope[rule.scope]}</Badge>
              </div>
              {rule.conditions ? (
                <p className="text-xs text-muted-foreground">{rule.conditions}</p>
              ) : null}
              {citation ? (
                <div className="flex flex-col gap-1 border-s-2 border-border/60 ps-2">
                  <p className="text-[11px] text-muted-foreground/70">
                    {t("terminology.livingMemory.styleRules.candidates.citation", {
                      doc: citation.doc,
                    })}
                  </p>
                  {citation.quote ? (
                    <p className="text-[11px] italic text-muted-foreground/60">
                      {citation.quote}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={!canReview}
                  onClick={() => setEditing(rule)}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={!canReview}
                  onClick={() => onReview(rule.id, "reject")}
                >
                  {t("agent.reject")}
                </Button>
                <Button
                  className="h-7 px-2 text-xs"
                  disabled={!canReview}
                  onClick={() => onReview(rule.id, "approve")}
                >
                  {t("agent.approve")}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}

      {remaining > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => setVisibleCount((count) => count + BATCH_SIZE)}
          >
            {t("common.listShowMore", { count: formatCount(remaining, locale) })}
          </Button>
          {canReview ? (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setStaged(pending.slice(visibleCount).map((rule) => rule.id))}
            >
              {t("terminology.livingMemory.styleRules.candidates.dismissRest", {
                count: formatCount(remaining, locale),
              })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {staged.length > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <span>
            {t("terminology.livingMemory.styleRules.candidates.dismissedNotice", {
              count: formatCount(staged.length, locale),
            })}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setStaged([])}>
            {t("terminology.livingMemory.styleRules.candidates.undoDismiss")}
          </Button>
        </div>
      ) : null}

      {/* Keyed on the rule id so the dialog's field state resets per candidate. */}
      {editing ? (
        <CandidateEditDialog
          key={editing.id}
          rule={editing}
          labels={labels}
          onClose={() => setEditing(null)}
          onSave={onSave}
        />
      ) : null}
    </div>
  )
}
