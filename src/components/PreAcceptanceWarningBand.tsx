import { AlertTriangle, Info } from "lucide-react"
import type { PreAcceptanceWarning } from "@/lib/terminology/preacceptance"
import { cn } from "@/lib/utils"

/**
 * Advisory terminology warning band for AI copilot completions (Slice 4).
 *
 * Renders nothing when there are no warnings. ADVISORY ONLY — this band must
 * never block accepting/committing a completion. `forbidden-present` is the
 * louder signal (amber, alert icon); `preferred-absent` is the quieter nudge
 * (info icon). Styling is warning/amber, never error/red — a banned rendering
 * is still a suggestion the human owns the final call on.
 *
 * SWARM-TODO(WS-WARN glue wave): This component is standalone and NOT yet
 * mounted. The glue wave must mount it in the copilot completion path in
 * `src/components/ProjectWorkspace.tsx` (FORBIDDEN to this agent — owned by
 * another actor). It must:
 *   1. compute warnings via detectPreAcceptanceWarnings(completionText,
 *      sourceText, concepts) as soon as the completion returns;
 *   2. re-render against the POST-ACCEPT back-translation verdict (warnings
 *      recompute when the committed text / BT changes);
 *   3. stay advisory — it informs, it does not gate the accept/commit button.
 */

export interface PreAcceptanceWarningBandProps {
  warnings: PreAcceptanceWarning[]
  className?: string
}

export function PreAcceptanceWarningBand({ warnings, className }: PreAcceptanceWarningBandProps) {
  if (warnings.length === 0) return null

  // Louder forbidden warnings first.
  const ordered = [...warnings].sort((a, b) => {
    if (a.kind === b.kind) return 0
    return a.kind === "forbidden-present" ? -1 : 1
  })

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] dark:border-amber-900/40 dark:bg-amber-950/40",
        className,
      )}
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Terminology advisory
      </span>
      <ul className="flex flex-col gap-1">
        {ordered.map((w, i) => {
          const forbidden = w.kind === "forbidden-present"
          return (
            <li
              key={`${w.conceptId}-${w.kind}-${i}`}
              className={cn(
                "flex items-start gap-1.5",
                forbidden
                  ? "font-medium text-amber-800 dark:text-amber-200"
                  : "text-amber-700/90 dark:text-amber-300/80",
              )}
            >
              {forbidden ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span>
                {forbidden ? (
                  <>
                    Forbidden rendering{" "}
                    <span className="font-semibold">&ldquo;{w.offendingText}&rdquo;</span> used for{" "}
                    <span className="font-semibold">{w.sourceTerm}</span>.
                  </>
                ) : (
                  <>
                    No approved rendering of{" "}
                    <span className="font-semibold">{w.sourceTerm}</span> found in the completion.
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
