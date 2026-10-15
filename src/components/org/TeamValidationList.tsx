// AQU-1969: the project Team card's validate assignments — one line per
// assignment, each with the assignee's OWN approvals, furthest behind first:
//
//   Ana  [=====      ]                                             6 left
//        Deuteronomy 1–10 · Validated 34 of 40 · 6 left · 2 changed since
//
// Apart from the per-person translate rows above it, because the two are
// different measures — "validated by anyone" against "approved by them" — and
// one bar summing both would mean neither. The row keeps the translate row's
// shape (name, bar, stat) so the card reads as one list.

import { UserChip } from "@/components/UserChip"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressPercent } from "@/lib/progress/progress-percent"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"
import {
  compareValidationBehind,
  validationHasAudio,
  validationLeftOverall,
} from "@/lib/assignments/validation-progress"
import type { ValidationAssignment } from "@/lib/sync/assignments"
import { useValidationProgressLines } from "./use-validation-progress"

export function TeamValidationList({
  validations,
  showLane,
}: {
  validations: readonly ValidationAssignment[]
  /** Name each row's language — only worth saying on a project with several. */
  showLane: boolean
}) {
  const t = useT()
  const progressLines = useValidationProgressLines()
  if (validations.length === 0) return null
  // The server sends them furthest behind first; sorted again here so the
  // order never rests on a wire contract.
  const rows = [...validations].sort(compareValidationBehind)
  return (
    <div className="mt-3" data-testid="overview-team-validations">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("org.validationProgress.heading")}</h3>
      <ul className="space-y-2">
        {rows.map((v) => {
          const lines = progressLines(v.validation, validationHasAudio(v.validation))
          const left = validationLeftOverall(v.validation)
          const pct = progressPercent(v.validation.text.validated, v.validation.text.total)
          const lead = [v.scopeLabel, showLane ? v.laneName || v.targetLang || null : null]
            .filter((part): part is string => !!part)
            .join(" · ")
          return (
            <li key={v.assignmentId} data-testid={`overview-team-validation-${v.assignmentId}`}>
              <div className="flex items-center gap-3 text-sm">
                <UserChip userId={v.assigneeUserId} username={v.username} size="sm" className="w-40 shrink-0" />
                {/* The text-validated tone, as on the rows above: these are
                    approvals, and this person's are the only ones counted. */}
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={`block h-full rounded-full transition-all ${PROGRESS_BG.textValidated}`}
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                  {left > 0
                    ? t("org.validationProgress.left", { count: left })
                    : t("org.projectOverview.plan.nothingLeft")}
                </span>
              </div>
              {/* Under the bar, not under the name: w-40 plus the row's gap. */}
              <div className="ms-[10.75rem] mt-0.5 text-xs tabular-nums text-muted-foreground">
                <p data-testid={`overview-team-validation-text-${v.assignmentId}`}>
                  {lead ? `${lead} · ${lines.text}` : lines.text}
                </p>
                {lines.audio && (
                  <p data-testid={`overview-team-validation-audio-${v.assignmentId}`}>{lines.audio}</p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
