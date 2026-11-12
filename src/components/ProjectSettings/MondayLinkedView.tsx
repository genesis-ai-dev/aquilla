// Monday.com linked-state view — status row (board name, enabled switch, last
// push), structure-stale banner, mapping editor / read-only table, and the
// reconfigure-with-AI textarea. Split from MondayIntegrationSection to keep
// each file under the ~500-line budget; all state lives in the parent.
//
// An Airtable table link shows the same view (AQU-804): it passes its
// `target` (the table and its link), its record line, words and field types;
// everything defaults to Monday's.

import type { ReactNode } from "react"
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { AppTooltip } from "@/components/ui/tooltip"
import { SparkleButton } from "@/components/SparkleButton"
import type { MondayBoardLink, MondayBoardStructure } from "@/lib/monday/api"
import {
  MONDAY_COLUMN_PROFILE,
  MONDAY_METRIC_KEYS,
  type MondayColumnMapping,
  type MondayMapping,
} from "@/lib/monday/types"
import {
  MONDAY_LINKED_VIEW_COPY,
  MONDAY_MAPPING_COPY,
  type ColumnProfile,
  type LinkedViewCopy,
  type MappingCopy,
} from "@/lib/integrations/sync-ui"
import type { MondayNewColumn } from "./useMondayBoardChanges"
import { MondayMappingEditor, MondayMappingTable } from "./MondayMappingEditor"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { RichMessage } from "@/lib/i18n/RichMessage"

/** What the view reads from a link, whichever provider it is. */
export type SyncLinkSummary = Pick<
  MondayBoardLink,
  "enabled" | "structureStale" | "lastPushedAt" | "lastPushStatus" | "lastPushError"
> &
  Partial<Pick<MondayBoardLink, "boardId" | "boardName" | "boardUrl">> & {
    config: { columns: MondayColumnMapping[]; itemGranularity: string; fileSubitems?: unknown }
  }

export function MondayLinkedView({
  link,
  structure,
  canManage,
  toggling,
  syncing,
  syncNotice,
  savingMapping,
  analyzing,
  reconfigureMsg,
  onReconfigureMsg,
  onToggleEnabled,
  onSyncNow,
  onSaveMapping,
  onReconfigure,
  onUnlink,
  warnings,
  missingColumns = null,
  newColumns = [],
  requestedRow = null,
  onMapColumn,
  onDismissColumn,
  checkingBoard = false,
  structureLoading = false,
  target,
  granularityLabel,
  copy = MONDAY_LINKED_VIEW_COPY,
  mappingCopy = MONDAY_MAPPING_COPY,
  profile = MONDAY_COLUMN_PROFILE,
  idPrefix = "monday",
  fileSubitems,
}: {
  link: SyncLinkSummary
  structure: MondayBoardStructure | null
  canManage: boolean
  toggling: boolean
  syncing: boolean
  syncNotice: string | null
  savingMapping: boolean
  analyzing: boolean
  reconfigureMsg: string
  onReconfigureMsg: (v: string) => void
  onToggleEnabled: (enabled: boolean) => void
  onSyncNow: () => void
  onSaveMapping: (columns: MondayMapping["columns"]) => void
  onReconfigure: () => void
  onUnlink: () => void
  warnings: string[]
  /** The column picker: add Aquilla's columns to the board and map them. */
  missingColumns?: ReactNode
  /** Columns on the board that weren't there when the link was saved. */
  newColumns?: MondayNewColumn[]
  /** "Map it" was clicked: the editor adds a row for this column. */
  requestedRow?: { column: MondayNewColumn; nonce: number } | null
  onMapColumn?: (column: MondayNewColumn) => void
  onDismissColumn?: (columnId: string) => void
  /** A board read or a dismiss is running: what the box offers may change. */
  checkingBoard?: boolean
  /** The board's columns haven't loaded yet, so the mapping has no titles. */
  structureLoading?: boolean
  /** What the link pushes to and where it opens (Monday: the board). */
  target?: { name: string; url: string | null }
  /** The "one item per …" line (Monday's by default). */
  granularityLabel?: string
  copy?: LinkedViewCopy
  mappingCopy?: MappingCopy
  profile?: ColumnProfile
  /** Prefix of element ids and test ids ("monday" by default). */
  idPrefix?: string
  /** Monday's "Files as subitems" switch (one item per project only); absent hides it. */
  fileSubitems?: { toggling: boolean; onToggle: (on: boolean) => void }
}) {
  const { t } = useI18n()
  const showNewColumns = canManage && newColumns.length > 0
  const perProject = link.config.itemGranularity !== "file"
  const subitemsOn = perProject && link.config.fileSubitems != null
  const shown = target ?? {
    name: link.boardName ?? link.boardId ?? "",
    url: link.boardUrl ?? structure?.url ?? null,
  }
  return (
    <div className="space-y-4">
      {link.structureStale && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          data-testid={`${idPrefix}-board-changes`}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {showNewColumns ? (
            <div className="min-w-0 flex-1 space-y-2">
              <p>{t(copy.changesIntro)}</p>
              <ul className="space-y-1.5">
                {newColumns.map((column) => (
                  <li key={column.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{column.title}</span>
                    {mappableMetric(column.type, profile) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={checkingBoard}
                        onClick={() => {
                          onMapColumn?.(column)
                          document
                            .querySelector(`[data-testid="${idPrefix}-mapping-editor"]`)
                            ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
                        }}
                      >
                        {t("projectSettings.monday.boardChangesMap")}
                      </Button>
                    ) : (
                      <span className="text-xs">{t(copy.changesReadOnly)}</span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={checkingBoard}
                      onClick={() => onDismissColumn?.(column.id)}
                    >
                      {t("projectSettings.monday.boardChangesDismiss")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <span>{t(copy.structureStale)}</span>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 text-sm">
          <p>
            {t(copy.linkedPrefix)}{" "}
            <span className="font-medium">{shown.name}</span>
          </p>
          {shown.url && (
            <a href={shown.url} target="_blank" rel="noopener noreferrer" className="underline">
              {t(copy.openTarget)}
            </a>
          )}
          <p className="text-xs text-muted-foreground">
            {granularityLabel ??
              (subitemsOn
                ? t("projectSettings.monday.oneItemWithSubitemsLabel")
                : t("projectSettings.monday.oneItemPerLabel", {
                    granularity: perProject ? "project" : "file",
                  }))}
            {" "}
            {link.lastPushedAt ? (
              <RichMessage
                k={
                  link.lastPushStatus === "ok"
                    ? "projectSettings.monday.lastPushOk"
                    : "projectSettings.monday.lastPushFailed"
                }
                values={{
                  date: <DateTooltip value={link.lastPushedAt} label={t("common.date.pushed")} />,
                }}
              />
            ) : (
              t("projectSettings.monday.notPushedYet")
            )}
          </p>
          {link.lastPushStatus === "error" && link.lastPushError && (
            <p className="text-xs text-destructive">{link.lastPushError}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm">
            <FieldLabel htmlFor={`${idPrefix}-sync-enabled`} className="text-sm">
              {t("projectSettings.monday.syncToggleLabel")}
            </FieldLabel>
            <Switch
              id={`${idPrefix}-sync-enabled`}
              checked={link.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={!canManage || toggling}
            />
          </span>
          {/* "Sync now" is a push too: while the Sync switch is off, nothing
              may write to the board, so it waits for the switch. */}
          <AppTooltip content={link.enabled ? null : t(copy.syncNowPaused)}>
            <Button variant="outline" onClick={onSyncNow} disabled={!canManage || syncing || !link.enabled}>
              {syncing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              {t("projectSettings.monday.syncNowButton")}
            </Button>
          </AppTooltip>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(copy.removeLinkAria)}
            onClick={onUnlink}
            disabled={!canManage}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {syncNotice && <p className="text-sm text-muted-foreground">{syncNotice}</p>}

      {fileSubitems && perProject && (
        <div className="flex items-start justify-between gap-3" data-testid={`${idPrefix}-file-subitems`}>
          <div className="space-y-0.5">
            <FieldLabel htmlFor={`${idPrefix}-file-subitems`} className="text-sm">
              {t("projectSettings.monday.fileSubitemsLabel")}
            </FieldLabel>
            <p className="text-xs text-muted-foreground">{t("projectSettings.monday.fileSubitemsDescription")}</p>
          </div>
          <Switch
            id={`${idPrefix}-file-subitems`}
            checked={subitemsOn}
            onCheckedChange={fileSubitems.onToggle}
            disabled={!canManage || fileSubitems.toggling}
          />
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">{t(copy.mappingLabel)}</p>
        {missingColumns}
        {canManage && structureLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner /> {t(copy.loadingColumns)}
          </p>
        ) : canManage ? (
          <MondayMappingEditor
            key={JSON.stringify(link.config.columns)}
            initialColumns={link.config.columns}
            requestedRow={requestedRow ? { row: rowFor(requestedRow.column, profile), nonce: requestedRow.nonce } : null}
            structure={structure}
            disabled={!canManage}
            saving={savingMapping}
            onSave={onSaveMapping}
            copy={mappingCopy}
            readOnlyTypes={profile.readOnlyTypes}
            testId={`${idPrefix}-mapping-editor`}
          />
        ) : (
          <MondayMappingTable columns={link.config.columns} structure={structure} copy={mappingCopy} />
        )}
      </div>

      {canManage && (
        <div className="space-y-2">
          <FieldLabel htmlFor={`${idPrefix}-reconfigure`} className="text-sm">
            {t("projectSettings.monday.reconfigureWithAiLabel")}
          </FieldLabel>
          <div className="flex items-start gap-2">
            <Textarea
              id={`${idPrefix}-reconfigure`}
              value={reconfigureMsg}
              onChange={(e) => onReconfigureMsg(e.target.value)}
              placeholder={t(copy.reconfigurePlaceholder)}
              rows={2}
            />
            <SparkleButton
              disabled={reconfigureMsg.trim().length === 0}
              loading={analyzing}
              onComplete={onReconfigure}
              tooltip={t("projectSettings.monday.reconfigureTooltip")}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** The first metric that can write to a column of this type, or null when none can. */
function mappableMetric(columnType: string, profile: ColumnProfile): MondayColumnMapping["metric"] | null {
  if (profile.readOnlyTypes.has(columnType)) return null
  return MONDAY_METRIC_KEYS.find((metric) => profile.writableTypesByMetric[metric].includes(columnType)) ?? null
}

function rowFor(column: MondayNewColumn, profile: ColumnProfile): MondayColumnMapping {
  return {
    columnId: column.id,
    columnType: column.type,
    metric: mappableMetric(column.type, profile) ?? "completion_pct",
  }
}
