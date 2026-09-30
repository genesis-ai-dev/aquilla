/**
 * Per-rule applicability editor (AQU-934 phase 2).
 *
 * Lists the rows that decide where an approved rule reaches — genre, book,
 * file, section, passage or segment — and adds new ones. Rows added here are
 * always `assignedBy: "human"`; `"model"` rows come from extraction and
 * `"inherited"` is reserved for deliberate materialization of computed
 * inheritance, so neither is offered as a choice.
 */

import { useState } from "react"
import { Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type {
  ApplicabilityRelationship,
  ApplicabilityTargetType,
  RuleApplicability,
  StyleRule,
  UpsertApplicabilityInput,
} from "@/lib/rules/style-rule-types"

/** Specificity ladder, broadest first — the order the picker offers. */
const TARGET_TYPES: readonly ApplicabilityTargetType[] = [
  "genre",
  "book",
  "file",
  "section",
  "passage",
  "segment",
]

const TARGET_LABEL_KEY: Record<ApplicabilityTargetType, MessageKey> = {
  genre: "terminology.livingMemory.styleRules.scope.genre",
  book: "terminology.livingMemory.styleRules.target.book",
  file: "common.file",
  section: "terminology.livingMemory.styleRules.scope.section",
  passage: "terminology.livingMemory.styleRules.scope.passage",
  segment: "terminology.livingMemory.styleRules.scope.segment",
}

const TARGET_HINT_KEY: Record<ApplicabilityTargetType, MessageKey> = {
  genre: "terminology.livingMemory.styleRules.applicability.hint.genre",
  book: "terminology.livingMemory.styleRules.applicability.hint.book",
  file: "terminology.livingMemory.styleRules.applicability.hint.file",
  section: "terminology.livingMemory.styleRules.applicability.hint.section",
  passage: "terminology.livingMemory.styleRules.applicability.hint.passage",
  segment: "terminology.livingMemory.styleRules.applicability.hint.segment",
}

const RELATIONSHIPS: readonly ApplicabilityRelationship[] = [
  "applies",
  "likely_applies",
  "excluded",
]

const RELATIONSHIP_LABEL_KEY: Record<ApplicabilityRelationship, MessageKey> = {
  applies: "terminology.livingMemory.styleRules.relationship.applies",
  likely_applies: "terminology.livingMemory.styleRules.relationship.likelyApplies",
  excluded: "terminology.livingMemory.styleRules.relationship.excluded",
}

const ASSIGNED_BY_LABEL_KEY: Record<RuleApplicability["assignedBy"], MessageKey> = {
  human: "terminology.livingMemory.styleRules.assignedBy.human",
  model: "terminology.livingMemory.styleRules.assignedBy.model",
  inherited: "terminology.livingMemory.styleRules.assignedBy.inherited",
}

interface RuleApplicabilityDialogProps {
  rule: StyleRule | null
  rows: RuleApplicability[]
  canManage: boolean
  onClose: () => void
  onAdd: (row: UpsertApplicabilityInput) => void
  onRemove: (applicabilityId: string) => void
}

export function RuleApplicabilityDialog({
  rule,
  rows,
  canManage,
  onClose,
  onAdd,
  onRemove,
}: RuleApplicabilityDialogProps) {
  const t = useT()
  const [targetType, setTargetType] = useState<ApplicabilityTargetType>("book")
  const [targetId, setTargetId] = useState("")
  const [relationship, setRelationship] = useState<ApplicabilityRelationship>("applies")

  if (!rule) return null

  const typeItems = Object.fromEntries(TARGET_TYPES.map((v) => [v, t(TARGET_LABEL_KEY[v])]))
  const relationshipItems = Object.fromEntries(
    RELATIONSHIPS.map((v) => [v, t(RELATIONSHIP_LABEL_KEY[v])]),
  )

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("terminology.livingMemory.styleRules.applicability.title")}
          </DialogTitle>
          <DialogDescription>{rule.instruction}</DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 italic">
            {t("terminology.livingMemory.styleRules.applicability.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
              >
                <span className="text-xs text-muted-foreground">
                  {t(TARGET_LABEL_KEY[row.targetType])}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {row.targetId}
                </span>
                <Badge variant="outline">{t(RELATIONSHIP_LABEL_KEY[row.relationship])}</Badge>
                <Badge variant="ghost">{t(ASSIGNED_BY_LABEL_KEY[row.assignedBy])}</Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  disabled={!canManage}
                  onClick={() => onRemove(row.id)}
                  aria-label={t("terminology.livingMemory.styleRules.applicability.removeAria")}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <FieldGroup>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="applicability-type">
                {t("terminology.livingMemory.styleRules.applicability.typeLabel")}
              </FieldLabel>
              <Select
                items={typeItems}
                value={targetType}
                onValueChange={(value) => setTargetType(value as ApplicabilityTargetType)}
              >
                <SelectTrigger id="applicability-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {TARGET_TYPES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(TARGET_LABEL_KEY[v])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="applicability-relationship">
                {t("terminology.livingMemory.styleRules.applicability.relationshipLabel")}
              </FieldLabel>
              <Select
                items={relationshipItems}
                value={relationship}
                onValueChange={(value) => setRelationship(value as ApplicabilityRelationship)}
              >
                <SelectTrigger id="applicability-relationship">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RELATIONSHIPS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(RELATIONSHIP_LABEL_KEY[v])}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="applicability-target">
              {t("terminology.livingMemory.styleRules.applicability.valueLabel")}
            </FieldLabel>
            <Input
              id="applicability-target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              disabled={!canManage}
            />
            <FieldDescription>{t(TARGET_HINT_KEY[targetType])}</FieldDescription>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.done")}
          </Button>
          <Button
            disabled={!canManage || !targetId.trim()}
            onClick={() => {
              onAdd({
                targetType,
                targetId: targetId.trim(),
                relationship,
                assignedBy: "human",
              })
              setTargetId("")
            }}
          >
            {t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
