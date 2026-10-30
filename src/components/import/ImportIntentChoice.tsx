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

import { Lock } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export type ImportIntent = "source" | "translation" | "recordings"

interface ImportIntentChoiceProps {
  value: ImportIntent
  onChange: (value: ImportIntent) => void
  /** Why new source text can't be imported here (role), or null. */
  sourceDisabledReason: string | null
  /** Why a translation can't be imported here (role, or no files), or null. */
  translationDisabledReason: string | null
  /** AQU-981: offer "Recordings" — absent leaves the choice at two cards.
   *  The string is why it can't be used here, or null when it can. */
  recordingsDisabledReason?: string | null
}

export function ImportIntentChoice({
  value,
  onChange,
  sourceDisabledReason,
  translationDisabledReason,
  recordingsDisabledReason,
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
    // AQU-981: recordings for lines already here, matched by their names.
    ...(recordingsDisabledReason !== undefined
      ? [{
          id: "recordings" as const,
          title: t("recordingsUpload.intent.title"),
          description: t("recordingsUpload.intent.description"),
          disabledReason: recordingsDisabledReason,
        }]
      : []),
  ]
  return (
    <div className="space-y-2">
      <h3 className="px-0.5 text-xs font-medium text-muted-foreground/70">{t("importExport.intent.groupLabel")}</h3>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as ImportIntent)}
        aria-label={t("importExport.intent.groupLabel")}
        className={cn("grid-cols-1", cards.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2")}
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
                  ? "cursor-not-allowed"
                  : selected
                    ? "cursor-pointer border-primary bg-primary/5"
                    : "cursor-pointer hover:bg-muted/50",
              )}
            >
              <RadioGroupItem value={card.id} disabled={disabled} className={cn("mt-0.5 shrink-0", disabled && "opacity-55")} aria-label={card.title} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("text-sm font-medium leading-tight", disabled && "opacity-55")}>{card.title}</span>
                <span className={cn("text-xs leading-relaxed text-muted-foreground", disabled && "opacity-55")}>{card.description}</span>
                {/* Why it is greyed out, in one short line in the card, never a
                    hover (AQU-2260, the locked-control line). */}
                {disabled && (
                  <span data-slot="locked-note" className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">{card.disabledReason}</span>
                  </span>
                )}
              </span>
            </label>
          )
          return label
        })}
      </RadioGroup>
    </div>
  )
}
