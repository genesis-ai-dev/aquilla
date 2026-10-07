/**
 * MatchOptionsFields (AQU-1271) — the shared "how should this term match"
 * checkbox group (fold marks, affixes, case sensitivity), reused by
 * AddConceptDialog and the term detail page. `resolved` supplies the
 * effective (defaulted) values; `value`/`onChange` carry the concept's own
 * explicit overrides so the caller can persist only what the user touched.
 */

import { Checkbox } from "@/components/ui/checkbox"
import { FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TermMatchOptions } from "@/lib/terminology/types"
import type { ResolvedMatchOptions } from "@/lib/terminology/match-options"

interface Props {
  value: TermMatchOptions
  resolved: ResolvedMatchOptions
  showFoldMarks: boolean
  hasAffixInventory: boolean
  caseSensitive: boolean
  disabled?: boolean
  idPrefix: string
  onChange: (next: TermMatchOptions) => void
  onCaseSensitiveChange: (v: boolean) => void
  onSetUpAffixes?: () => void
}

export function MatchOptionsFields(p: Props) {
  const t = useT()
  const row = (id: string, label: string, checked: boolean, onChecked: (v: boolean) => void) => (
    <div className="flex items-center gap-2" key={id}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={p.disabled}
        onCheckedChange={(c) => onChecked(c === true)}
      />
      <FieldLabel htmlFor={id} className="text-xs font-normal">
        {label}
      </FieldLabel>
    </div>
  )
  return (
    <div className="grid gap-2" data-testid="match-options">
      {p.showFoldMarks &&
        row(`${p.idPrefix}-fold`, t("terminology.match.foldMarks"), p.resolved.foldMarks, (v) =>
          p.onChange({ ...p.value, foldMarks: v }),
        )}
      {p.hasAffixInventory
        ? row(`${p.idPrefix}-affix`, t("terminology.match.affixes"), p.resolved.affixes, (v) =>
            p.onChange({ ...p.value, affixes: v }),
          )
        : p.onSetUpAffixes && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="justify-start px-0"
              onClick={p.onSetUpAffixes}
            >
              {t("terminology.match.setUpAffixes")}
            </Button>
          )}
      {row(`${p.idPrefix}-case`, t("terminology.match.caseSensitive"), p.caseSensitive, p.onCaseSensitiveChange)}
    </div>
  )
}
