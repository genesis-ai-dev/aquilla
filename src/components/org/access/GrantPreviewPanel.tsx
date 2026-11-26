/**
 * AQU-2320: "What changes" — the server's dry run, drawn. Nothing here
 * recomputes access; every line reads a field of GrantPreview.
 */
import { roleLabel } from "@/components/access/labels"
import { formatScopePath, HIDDEN_ANCESTORS } from "@/lib/access/scope-path"
import type { ScopeRef } from "@/lib/access/types"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

import type { GrantPreview } from "./give-access-data"

export type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: GrantPreview }
  | { status: "refused"; message: string }
  | { status: "error" }

const placeName = (scope: ScopeRef) => (scope.hidden || !scope.name ? HIDDEN_ANCESTORS : scope.name)

/** Changes that share a before→after pair read as one line ("Raises Viewer to Reviewer on 3 projects"). */
function groupedLines(t: TFunction, preview: GrantPreview): string[] {
  const groups = new Map<string, { kind: "raises" | "lowers" | "opens"; from: number | null; to: number | null; count: number }>()
  for (const change of preview.changes) {
    const from = change.before?.roleLevel ?? null
    const to = change.after?.roleLevel ?? null
    const kind = from == null ? "opens" : to != null && to > from ? "raises" : "lowers"
    const key = `${kind}:${from}:${to}`
    const group = groups.get(key) ?? { kind, from, to, count: 0 }
    group.count += 1
    groups.set(key, group)
  }
  return [...groups.values()].map((g) =>
    g.kind === "opens"
      ? t("org.access.give.opens", { count: g.count, role: roleLabel(t, g.to) })
      : t(g.kind === "raises" ? "org.access.give.raises" : "org.access.give.lowers", {
          count: g.count,
          from: roleLabel(t, g.from),
          to: roleLabel(t, g.to),
        }),
  )
}

export function previewLines(t: TFunction, preview: GrantPreview, email: string | null): string[] {
  const lines: string[] = []
  const path = formatScopePath(preview.placePath)
  if (preview.invite && email) lines.push(t("org.access.give.inviteNote", { email }))
  if (preview.redundant && preview.here.before) {
    lines.push(t("org.access.give.redundant", { role: roleLabel(t, preview.here.before.roleLevel), via: placeName(preview.here.before.via) }))
  } else {
    lines.push(t("org.access.give.gainsHere", { role: roleLabel(t, preview.roleLevel), path }))
  }
  if (preview.replaces != null && preview.replaces !== preview.roleLevel) {
    lines.push(t("org.access.give.replaces", { role: roleLabel(t, preview.replaces) }))
  }
  lines.push(...groupedLines(t, preview))
  if (preview.includesFutureProjects) {
    lines.push(t("org.access.give.futureProjects", { team: placeName(preview.placePath[preview.placePath.length - 1]) }))
  }
  if (preview.guest.after) lines.push(t("org.access.give.staysGuest"))
  else if (preview.guest.before) lines.push(t("org.access.give.becomesMember"))
  return lines
}

export function GrantPreviewPanel({ state, email }: { state: PreviewState; email: string | null }) {
  const t = useT()
  return (
    <section
      // Focusable so Tab reaches the preview between the blanks and the buttons (AC7).
      tabIndex={0}
      aria-labelledby="give-access-preview-heading"
      aria-live="polite"
      aria-busy={state.status === "loading" || undefined}
      data-testid="grant-preview"
      className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-muted/40 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <h3 id="give-access-preview-heading" className="font-medium">{t("org.access.give.whatChanges")}</h3>
      {state.status === "idle" && <p className="text-muted-foreground">{t("org.access.give.previewIdle")}</p>}
      {state.status === "loading" && <p className="text-muted-foreground">{t("org.access.give.previewLoading")}</p>}
      {state.status === "error" && <p role="alert" className="text-destructive">{t("org.access.give.previewError")}</p>}
      {state.status === "refused" && <p role="alert" data-testid="grant-preview-refused" className="text-destructive">{state.message}</p>}
      {state.status === "ready" && (
        <ul className="flex list-disc flex-col gap-1 ps-4">
          {previewLines(t, state.preview, email).map((line) => (
            <li key={line} data-testid="grant-preview-line">{line}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
