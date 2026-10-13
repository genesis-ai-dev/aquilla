// Monday.com linked-state view — status row (board name, enabled switch, last
// push), structure-stale banner, mapping editor / read-only table, and the
// reconfigure-with-AI textarea. Split from MondayIntegrationSection to keep
// each file under the ~500-line budget; all state lives in the parent.

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
  MONDAY_METRIC_KEYS,
  MONDAY_READONLY_COLUMN_TYPES,
  MONDAY_WRITABLE_TYPES_BY_METRIC,
  type MondayColumnMapping,
  type MondayMapping,
} from "@/lib/monday/types"
import type { MondayNewColumn } from "./useMondayBoardChanges"
import { MondayMappingEditor, MondayMappingTable } from "./MondayMappingEditor"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { RichMessage } from "@/lib/i18n/RichMessage"

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
}: {
  link: MondayBoardLink
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
}) {
  const { t } = useI18n()
  const showNewColumns = canManage && newColumns.length > 0
  return (
    <div className="space-y-4">
      {link.structureStale && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          data-testid="monday-board-changes"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {showNewColumns ? (
            <div className="min-w-0 flex-1 space-y-2">
              <p>{t("projectSettings.monday.boardChangesIntro")}</p>
              <ul className="space-y-1.5">
                {newColumns.map((column) => (
                  <li key={column.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{column.title}</span>
                    {mappableMetric(column.type) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onMapColumn?.(column)
                          document
                            .querySelector('[data-testid="monday-mapping-editor"]')
                            ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
                        }}
                      >
                        {t("projectSettings.monday.boardChangesMap")}
                      </Button>
                    ) : (
                      <span className="text-xs">{t("projectSettings.monday.boardChangesReadOnly")}</span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => onDismissColumn?.(column.id)}>
                      {t("projectSettings.monday.boardChangesDismiss")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <span>{t("projectSettings.monday.structureStaleWarning")}</span>
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
            {t("projectSettings.monday.linkedBoardPrefix")}{" "}
            <span className="font-medium">{link.boardName ?? link.boardId}</span>
          </p>
          {(link.boardUrl ?? structure?.url) && (
            <a href={link.boardUrl ?? structure?.url ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">
              {t("projectSettings.monday.overviewOpenBoard")}
            </a>
          )}
          <p className="text-xs text-muted-foreground">
            {t("projectSettings.monday.oneItemPerLabel", {
              granularity: link.config.itemGranularity === "file" ? "file" : "project",
            })}
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
            <FieldLabel htmlFor="monday-sync-enabled" className="text-sm">
              {t("projectSettings.monday.syncToggleLabel")}
            </FieldLabel>
            <Switch
              id="monday-sync-enabled"
              checked={link.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={!canManage || toggling}
            />
          </span>
          {/* "Sync now" is a push too: while the Sync switch is off, nothing
              may write to the board, so it waits for the switch. */}
          <AppTooltip content={link.enabled ? null : t("projectSettings.monday.syncNowPausedTooltip")}>
            <Button variant="outline" onClick={onSyncNow} disabled={!canManage || syncing || !link.enabled}>
              {syncing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
              {t("projectSettings.monday.syncNowButton")}
            </Button>
          </AppTooltip>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("projectSettings.monday.removeBoardLinkAriaLabel")}
            onClick={onUnlink}
            disabled={!canManage}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {syncNotice && <p className="text-sm text-muted-foreground">{syncNotice}</p>}

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("projectSettings.monday.columnMappingLabel")}</p>
        {missingColumns}
        {canManage ? (
          <MondayMappingEditor
            key={JSON.stringify(link.config.columns)}
            initialColumns={link.config.columns}
            requestedRow={requestedRow ? { row: rowFor(requestedRow.column), nonce: requestedRow.nonce } : null}
            structure={structure}
            disabled={!canManage}
            saving={savingMapping}
            onSave={onSaveMapping}
          />
        ) : (
          <MondayMappingTable columns={link.config.columns} structure={structure} />
        )}
      </div>

      {canManage && (
        <div className="space-y-2">
          <FieldLabel htmlFor="monday-reconfigure" className="text-sm">
            {t("projectSettings.monday.reconfigureWithAiLabel")}
          </FieldLabel>
          <div className="flex items-start gap-2">
            <Textarea
              id="monday-reconfigure"
              value={reconfigureMsg}
              onChange={(e) => onReconfigureMsg(e.target.value)}
              placeholder={t("projectSettings.monday.reconfigurePlaceholder")}
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
function mappableMetric(columnType: string): MondayColumnMapping["metric"] | null {
  if (MONDAY_READONLY_COLUMN_TYPES.has(columnType)) return null
  return MONDAY_METRIC_KEYS.find((metric) => MONDAY_WRITABLE_TYPES_BY_METRIC[metric].includes(columnType)) ?? null
}

function rowFor(column: MondayNewColumn): MondayColumnMapping {
  return { columnId: column.id, columnType: column.type, metric: mappableMetric(column.type) ?? "completion_pct" }
}
