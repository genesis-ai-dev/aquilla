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
import { AppTooltip } from "@/components/ui/tooltip"
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

export function DcsSyncBadge({ cursor, onClick }: DcsSyncBadgeProps) {
  const { locale, t } = useI18n()
  if (!cursor) return null
  return (
    <AppTooltip content={pinTooltip(cursor, locale, t)} side="bottom">
      <Badge
        variant="outline"
        data-testid="dcs-sync-badge"
        render={
          onClick
            ? <button type="button" onClick={onClick} aria-label={t("importExport.dcs.badgeAriaLabel")} />
            : undefined
        }
      >
        <DownloadCloud data-icon="inline-start" aria-hidden />
        {cursor.owner}/{cursor.repo} @ {cursor.ref}
      </Badge>
    </AppTooltip>
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
