/**
 * AQU-1365: the top of the Import dialog's first screen, "What are you
 * importing?": new source text, or a translation of a file already here.
 *
 * Two radio cards rather than a question screen of its own, so a source import
 * takes exactly the clicks it did before (New source text is preselected and
 * today's importer tiles sit right below it). The translation card says
 * "translation" and "target" in so many words: AQU-503 found people look for a
 * "Target Import", and AQU-1365 found a translator who never saw the old
 * three-dot entry at all.
 */

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export type ImportIntent = "source" | "translation"

interface ImportIntentChoiceProps {
  value: ImportIntent
  onChange: (value: ImportIntent) => void
  /** Why new source text can't be imported here (role), or null. */
  sourceDisabledReason: string | null
  /** Why a translation can't be imported here (role, or no files), or null. */
  translationDisabledReason: string | null
}

export function ImportIntentChoice({
  value,
  onChange,
  sourceDisabledReason,
  translationDisabledReason,
}: ImportIntentChoiceProps) {
  const t = useT()
  const cards: { id: ImportIntent; title: string; description: string; disabledReason: string | null }[] = [
    {
      id: "source",
      title: t("importExport.intent.source.title"),
      description: t("importExport.intent.source.description"),
      disabledReason: sourceDisabledReason,
    },
    {
      id: "translation",
      title: t("importExport.intent.translation.title"),
      description: t("importExport.intent.translation.description"),
      disabledReason: translationDisabledReason,
    },
  ]
  return (
    <div className="space-y-2">
      <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{t("importExport.intent.groupLabel")}</h3>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as ImportIntent)}
        aria-label={t("importExport.intent.groupLabel")}
        className="grid-cols-1 sm:grid-cols-2"
      >
        {cards.map((card) => {
          const disabled = card.disabledReason !== null
          const selected = value === card.id
          const label = (
            <label
              key={card.id}
              data-testid={`import-intent-${card.id}`}
              data-tooltip={import.meta.env.MODE === "test" && disabled ? card.disabledReason : undefined}
              aria-disabled={disabled || undefined}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                disabled
                  ? "cursor-not-allowed opacity-55"
                  : selected
                    ? "cursor-pointer border-primary bg-primary/5"
                    : "cursor-pointer hover:bg-muted/50",
              )}
            >
              <RadioGroupItem value={card.id} disabled={disabled} className="mt-0.5 shrink-0" aria-label={card.title} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium leading-tight">{card.title}</span>
                <span className="text-xs leading-relaxed text-muted-foreground">{card.description}</span>
              </span>
            </label>
          )
          return disabled ? <AppTooltip key={card.id} content={card.disabledReason}>{label}</AppTooltip> : label
        })}
      </RadioGroup>
    </div>
  )
}
