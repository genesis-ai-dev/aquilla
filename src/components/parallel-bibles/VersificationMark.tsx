// The visible mark on a version whose numbering does not line up with the
// editor's, so a translator never reads a different verse as if it matched.

import { ArrowLeftRight } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { VersificationNote } from "@/lib/parallel-bibles/versification"
import { cn } from "@/lib/utils"

export function VersificationMark({ note, className }: { note: VersificationNote; className?: string }) {
  const t = useT()
  const text =
    note.kind === "shifted"
      ? t("editor.bibles.versShifted", { here: note.here, ref: note.english })
      : note.kind === "psalmTitle"
        ? t("editor.bibles.versPsalmTitle", { offset: String(note.offset) })
        : note.kind === "psalmUnsure"
          ? t("editor.bibles.versPsalmUnsure")
          : t("editor.bibles.versCountDiffers", {
              verses: String(note.count),
              refVerses: String(note.refCount),
              version: note.refVersion,
            })
  return (
    <p
      data-testid="versification-mark"
      className={cn(
        "flex items-start gap-1 rounded bg-amber-100/70 px-1.5 py-1 text-[11px] leading-snug text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
        className,
      )}
    >
      <ArrowLeftRight className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  )
}
