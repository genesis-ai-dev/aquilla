// Monday.com linked-state view — status row (board name, enabled switch, last
// push), structure-stale banner, mapping editor / read-only table, and the
// reconfigure-with-AI textarea. Split from MondayIntegrationSection to keep
// each file under the ~500-line budget; all state lives in the parent.

import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { SparkleButton } from "@/components/SparkleButton"
import type { MondayBoardLink, MondayBoardStructure } from "@/lib/monday/api"
import type { MondayMapping } from "@/lib/monday/types"
import { MondayMappingEditor, MondayMappingTable } from "./MondayMappingEditor"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDateTime } from "@/lib/i18n/format"

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
}) {
  const { locale } = useI18n()
  return (
    <div className="space-y-4">
      {link.structureStale && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Board structure changed — review the mapping below.</span>
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
            Linked board: <span className="font-medium">{link.boardName ?? link.boardId}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            One item per {link.config.itemGranularity === "file" ? "file" : "project"}.
            {link.lastPushedAt
              ? ` Last push ${formatDateTime(link.lastPushedAt, locale)} — ${
                  link.lastPushStatus === "ok" ? "ok" : "failed"
                }.`
              : " Not pushed yet."}
          </p>
          {link.lastPushStatus === "error" && link.lastPushError && (
            <p className="text-xs text-destructive">{link.lastPushError}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm">
            <FieldLabel htmlFor="monday-sync-enabled" className="text-sm">
              Sync
            </FieldLabel>
            <Switch
              id="monday-sync-enabled"
              checked={link.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={!canManage || toggling}
            />
          </span>
          <Button variant="outline" size="sm" onClick={onSyncNow} disabled={!canManage || syncing}>
            {syncing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            Sync now
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove board link"
            onClick={onUnlink}
            disabled={!canManage}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {syncNotice && <p className="text-sm text-muted-foreground">{syncNotice}</p>}

      <div className="space-y-2">
        <p className="text-sm font-medium">Column mapping</p>
        {canManage ? (
          <MondayMappingEditor
            key={JSON.stringify(link.config.columns)}
            initialColumns={link.config.columns}
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
            Reconfigure with AI
          </FieldLabel>
          <div className="flex items-start gap-2">
            <Textarea
              id="monday-reconfigure"
              value={reconfigureMsg}
              onChange={(e) => onReconfigureMsg(e.target.value)}
              placeholder="Describe what to change — e.g. “track validated % instead of completion, one item per file”"
              rows={2}
            />
            <SparkleButton
              disabled={reconfigureMsg.trim().length === 0}
              loading={analyzing}
              onComplete={onReconfigure}
              tooltip="Ask AI to update the mapping"
            />
          </div>
        </div>
      )}
    </div>
  )
}
