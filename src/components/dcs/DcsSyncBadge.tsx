// DcsSyncBadge (AQU-615 wave 3) — compact workspace-header badge that makes a
// Door43 upstream link VISIBLE outside Project Settings. Until now the only
// place a user could discover that a project's source cells are synced from
// Door43 was the DcsUpstreamPanel buried in settings; translators saw
// upstream-owned source cells with no hint.
//
// Two exports:
//   • DcsSyncBadge — purely presentational. Takes the pinned DcsCursor as a
//     prop (no fetching inside) plus an optional onClick to jump to settings.
//     Renders nothing without a cursor, so callers can pass readCursor(...)
//     straight through.
//   • DcsSyncBadgeMount — the one-line mount for ProjectWorkspace: reads the
//     project's settings bag via useProjectSettings and derives the cursor
//     with readCursor (same read path as DcsUpstreamPanel). Renders nothing
//     when the project is not a DCS adapter.

import { useMemo } from "react"
import { DownloadCloud } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { InfoNote, NoteOnClick } from "@/components/ui/info-note"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { readCursor } from "@/lib/dcs/cursor"
import type { DcsCursor } from "@/lib/dcs/types"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { formatDate } from "@/lib/i18n/format"

export interface DcsSyncBadgeProps {
  /** The pinned upstream cursor, or null ⇒ render nothing. */
  cursor: DcsCursor | null
  /** Optional: navigate to Project Settings (where the link is managed). */
  onClick?: () => void
}

/** Full-pin tooltip: what's synced, from where, at which release, and where
 *  to manage it. */
function pinTooltip(cursor: DcsCursor, locale: string, t: TFunction): string {
  const imported = new Date(cursor.importedAt)
  const importedLabel = Number.isNaN(imported.getTime())
    ? cursor.importedAt
    : formatDate(imported, locale, {})
  return t("importExport.dcs.pinTooltip", {
    repo: `${cursor.owner}/${cursor.repo}`,
    subject: cursor.subject,
    ref: cursor.ref,
    imported: importedLabel,
  })
}

/**
 * AQU-2260 (Sam, Oct 29): the pin's explanation opens on click, never on
 * hover. As a button (it jumps to Project Settings) the badge keeps that
 * click, so the explanation is an (i) beside it; as a plain badge, the badge
 * itself opens it.
 */
export function DcsSyncBadge({ cursor, onClick }: DcsSyncBadgeProps) {
  const { locale, t } = useI18n()
  if (!cursor) return null
  const note = pinTooltip(cursor, locale, t)
  const repo = `${cursor.owner}/${cursor.repo}`
  if (!onClick) {
    return (
      <NoteOnClick note={note} testId="dcs-sync-badge">
        <Badge variant="outline">
          <DownloadCloud data-icon="inline-start" aria-hidden />
          {repo} @ {cursor.ref}
        </Badge>
      </NoteOnClick>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <Badge
        variant="outline"
        data-testid="dcs-sync-badge"
        render={<button type="button" onClick={onClick} aria-label={t("importExport.dcs.badgeAriaLabel")} />}
      >
        <DownloadCloud data-icon="inline-start" aria-hidden />
        {repo} @ {cursor.ref}
      </Badge>
      <InfoNote label={t("common.aboutAria", { name: repo })} testId="dcs-sync-badge-info" align="end">
        {note}
      </InfoNote>
    </span>
  )
}

export interface DcsSyncBadgeMountProps {
  projectId: string
  /** The caller's resolved role level on this project (gates settings PATCH
   *  inside the hook; reads are role-independent). */
  roleLevel: number | null
  onClick?: () => void
}

/** Settings-reading wrapper so the (huge) ProjectWorkspace mount stays a
 *  single line. Renders nothing when there is no dcsUpstream cursor. */
export function DcsSyncBadgeMount({ projectId, roleLevel, onClick }: DcsSyncBadgeMountProps) {
  const { settings } = useProjectSettings(projectId, roleLevel)
  const cursor = useMemo(
    () => readCursor(settings as Record<string, unknown>),
    [settings],
  )
  return <DcsSyncBadge cursor={cursor} onClick={onClick} />
}
