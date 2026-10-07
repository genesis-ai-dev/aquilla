// Data egress progress + results. Fail-loud contract: the engine finishes with
// whatever succeeded, so this panel must surface every skip (verbatim reason)
// and per-project error rather than pretending a partial export was complete.
// Tone stays calm/neutral (ExportDialog status-region precedent).

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Section } from "@/components/ui/page"
import type { EgressManifest, EgressProgressUpdate } from "@/lib/egress/types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export type EgressRunState =
  | { kind: "idle" }
  | { kind: "running"; progress: EgressProgressUpdate | null }
  | { kind: "done"; manifest: EgressManifest }
  | { kind: "error"; message: string }

const PHASE_LABEL_KEYS: Record<EgressProgressUpdate["phase"], MessageKey> = {
  preparing: "org.egress.results.preparing",
  text: "org.egress.results.exportingText",
  audio: "org.egress.results.exportingAudio",
  zipping: "org.egress.results.packaging",
  done: "org.egress.results.finishing",
}

function percent(p: EgressProgressUpdate): number {
  const phaseFraction = p.phase === "done" ? 1 : p.total > 0 ? p.done / p.total : 0
  // Clamp: the engine's final sentinel updates carry projectIndex ===
  // projectCount, which would otherwise read past 100%.
  return Math.min(
    100,
    Math.round(((p.projectIndex + phaseFraction) / Math.max(1, p.projectCount)) * 100),
  )
}

/** The engine's final org-level updates (packaging the combined zip) carry no
 *  project: projectName "" and projectIndex === projectCount. Render just the
 *  phase label — a "(n+1 of n)" suffix would be nonsense. */
function isOrgLevelSentinel(p: EgressProgressUpdate): boolean {
  return p.projectName === "" && p.projectIndex === p.projectCount
}

export function EgressResultsPanel({
  state,
  onCancel,
}: {
  state: EgressRunState
  onCancel: () => void
}) {
  const t = useT()
  if (state.kind === "idle") return null
  // Hoisted so the i18n lint sees state tags, not JSX copy.
  const running = state.kind === "running" ? state : null
  const errored = state.kind === "error" ? state : null
  const done = state.kind === "done" ? state : null

  const statusLine = (p: EgressProgressUpdate): string => {
    const phase = t(PHASE_LABEL_KEYS[p.phase])
    if (isOrgLevelSentinel(p)) return t("org.egress.results.phaseStatus", { phase })
    return t("org.egress.results.projectStatus", {
      phase,
      project: p.projectName,
      current: p.projectIndex + 1,
      total: p.projectCount,
      cached: p.fromCache ? t("org.egress.results.cachedSuffix") : "",
    })
  }

  return (
    <Section title={t("nav.workspaceActions.export")} contentClassName="flex flex-col gap-3">
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {running && (
          <>
            <p className="text-sm text-muted-foreground" data-testid="egress-status-line">
              {running.progress == null ? t("org.egress.results.preparingExport") : statusLine(running.progress)}
            </p>
            <Progress
              value={running.progress == null ? null : percent(running.progress)}
              aria-label={t("org.egress.results.progress")}
            />
            <div>
              <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
            </div>
          </>
        )}
        {errored && (
          <p className="text-sm text-destructive">{t("org.egress.results.failed", { message: errored.message })}</p>
        )}
        {done && (
          <>
            <p className="text-sm text-muted-foreground">
              {t("org.egress.results.complete")}
            </p>
            <ul className="flex flex-col gap-2">
              {done.manifest.projects.map((proj) => {
                const entryCount = proj.files.reduce((n, f) => n + f.entries.length, 0)
                const skipped = proj.files.flatMap((f) => f.skipped)
                // Transparency notes: entries that WERE written but not as
                // requested (fallback formats, source-doc honesty notes).
                const notes = proj.files.flatMap((f) =>
                  (f.notes ?? []).map((note) => ({ file: f.fileName, note })),
                )
                return (
                  <li key={proj.projectId} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{proj.projectName}</span>
                      {proj.fromCache && <Badge variant="secondary">{t("org.egress.results.cached")}</Badge>}
                      <span className="text-muted-foreground">
                        {t("org.egress.results.entryCount", { count: entryCount })}
                      </span>
                    </div>
                    {skipped.length > 0 && (
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
                        {skipped.map((s, i) => (
                          <li key={`${s.scope}-${i}`}>
                            {t("org.egress.results.skipped", { scope: s.scope, reason: s.reason })}
                          </li>
                        ))}
                      </ul>
                    )}
                    {notes.length > 0 && (
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
                        {notes.map((n, i) => (
                          <li key={`${n.file}-${i}`}>{t("org.egress.results.noteLine", { file: n.file, note: n.note })}</li>
                        ))}
                      </ul>
                    )}
                    {proj.errors.length > 0 && (
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-destructive">
                        {proj.errors.map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </Section>
  )
}
