import { useMemo, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import type { FixProposal } from "@/lib/rules/autofix"
import type { TranslationRule } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  open: boolean
  rule: TranslationRule
  proposal: FixProposal
  onClose: () => void
  onApply: (selectedCellIds: Set<string>) => void
  onAmendRule: () => void
  /**
   * AQU-186: when present, a typed-confirmation gate is shown before Apply.
   * The user must type this exact string (case-sensitive) to enable the
   * Apply button. Per spec: harmonization is irreversible-by-default, so
   * bulk Apply requires typed confirmation of the rule/check name.
   */
  confirmPhrase?: string
}

export function FixReviewPanel({ open, rule, proposal, onClose, onApply, onAmendRule, confirmPhrase }: Props) {
  const t = useT()
  const previews = proposal.kind === "none" ? [] : proposal.previews
  const initialSelected = useMemo(() => new Set(previews.map((p) => p.cellId)), [previews])
  const [selected, setSelected] = useState<Set<string>>(initialSelected)
  // Typed-confirmation state (AQU-186).
  const [confirmInput, setConfirmInput] = useState("")

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  function selectAll() { setSelected(new Set(previews.map((p) => p.cellId))) }
  function selectNone() { setSelected(new Set()) }

  const modeLabel =
    proposal.kind === "regex-replace"
      ? previews.some((p) => p.source === "cached-regex")
        ? t("rules.fixReview.modeCachedRegex")
        : t("rules.fixReview.modeBatchRegex")
      : proposal.kind === "per-cell" ? t("rules.fixReview.modePerCellRewrite") : ""

  // AQU-186: Apply is gated on typed confirmation when confirmPhrase is set.
  const confirmOk = confirmPhrase == null || confirmInput === confirmPhrase
  const applyDisabled = selected.size === 0 || !confirmOk

  function handleClose() {
    setConfirmInput("")
    onClose()
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <SheetContent side="right" className="w-[520px] max-w-[90vw] sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span>{rule.name}</span>
            <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted">
              {rule.severity === "major" ? t("rules.severity.major") : t("rules.severity.minor")}
            </span>
            {modeLabel && <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">{modeLabel}</span>}
          </SheetTitle>
        </SheetHeader>

        {proposal.kind === "none" ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">{proposal.reason}</p>
            <Button variant="outline" onClick={onAmendRule}>{t("rules.drawer.amendRuleButton")}</Button>
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("rules.fixReview.previewsReady", { count: previews.length })}
              </p>
              {previews.length > 1 && (
                <div className="flex gap-2 text-xs">
                  <button className="underline" onClick={selectAll}>{t("common.selectAll")}</button>
                  <button className="underline" onClick={selectNone}>{t("search.replace.selectNone")}</button>
                </div>
              )}
            </div>

            <ul className="mt-2 max-h-[60vh] space-y-2 overflow-auto">
              {previews.map((p) => (
                <li key={p.cellId} className="rounded border p-2 text-xs">
                  <label className="flex items-start gap-2">
                    <Checkbox checked={selected.has(p.cellId)} onCheckedChange={() => toggle(p.cellId)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-muted-foreground">
                        {t("rules.fixReview.cellLabel", { cellId: p.cellId })}
                      </div>
                      <div className="truncate line-through text-red-600 dark:text-red-400">{p.before}</div>
                      <div className="truncate text-green-700 dark:text-green-400">{p.after}</div>
                      {p.rationale && <div className="mt-1 text-[10px] text-muted-foreground">{p.rationale}</div>}
                    </div>
                  </label>
                </li>
              ))}
            </ul>

            {/* AQU-186: Typed confirmation gate for bulk harmonize Apply. */}
            {confirmPhrase != null && (
              <div className="mt-3 space-y-1">
                <p className="text-xs text-muted-foreground">
                  {t("rules.fixReview.irreversibleConfirmPrefix")}{" "}
                  <strong className="font-semibold text-foreground">{confirmPhrase}</strong>{" "}
                  {t("rules.fixReview.irreversibleConfirmSuffix")}
                </p>
                <Input
                  aria-label={t("rules.fixReview.confirmInputAriaLabel")}
                  placeholder={confirmPhrase}
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={handleClose}>{t("common.cancel")}</Button>
              <Button
                onClick={() => {
                  setConfirmInput("")
                  onApply(selected)
                }}
                disabled={applyDisabled}
              >
                {t("rules.fixReview.applyButton", { count: selected.size })}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
