// Small marks in the editing table's header over its narrow, unlabeled
// columns, each naming its column on hover. (Sam, 2026-09-28; the Text and
// Audio views — the Media view's table keeps its own header.)
//
// They line up with the columns they label by reproducing the row's widths:
// the gutter's select box (20px), 8px, the notices column (20px), 2px, and the
// number filling the rest; then, before the Target heading, the two 24px
// validation checks — text, then audio, which a validated line shows as the
// same green check.

import type { ReactNode } from "react"
import { AudioLines, Flag, Hash, SquareCheck, Type } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

function Mark({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <AppTooltip content={label}>
      <span role="img" aria-label={label} className={cn("flex justify-center", className)}>
        {children}
      </span>
    </AppTooltip>
  )
}

/** Over the row gutter: select, notices, and the number when lines are
 *  numbered — "Verse number" in a file of chapters (a book of the Bible),
 *  "Cell number" anywhere else (Sam, 2026-09-28). */
export function GutterMarks({ numbers }: { numbers: "verse" | "cell" | null }) {
  const t = useT()
  return (
    <div data-testid="table-gutter-marks" className="hidden items-center md:flex">
      <Mark label={t("editor.gutter.select")} className="w-5 shrink-0">
        <SquareCheck className="h-3 w-3" />
      </Mark>
      <div className="ms-2 flex min-w-0 flex-1 items-center gap-0.5">
        <Mark label={t("editor.gutter.notices")} className="w-5 shrink-0">
          <Flag className="h-3 w-3" />
        </Mark>
        {numbers && (
          <Mark
            label={t(numbers === "verse" ? "editor.gutter.verseNumber" : "editor.gutter.cellNumber")}
            className="min-w-0 flex-1"
          >
            <Hash className="h-3 w-3" />
          </Mark>
        )}
      </div>
    </div>
  )
}

/** Over the two validation checks, just before the Target heading. */
export function CheckMarks() {
  const t = useT()
  return (
    // -ms-3: the rows' two checks start 12px before the heading's text.
    <span data-testid="table-check-marks" className="hidden items-center gap-1.5 md:-ms-3 md:flex">
      <Mark label={t("editor.gutter.textChecks")} className="w-6">
        <Type className="h-3 w-3" />
      </Mark>
      <Mark label={t("editor.gutter.audioChecks")} className="w-6">
        <AudioLines className="h-3 w-3" />
      </Mark>
    </span>
  )
}
