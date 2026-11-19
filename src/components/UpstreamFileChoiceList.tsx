// AQU-1561: the upstream-file checkbox list, shared by the two places that ask
// "which of this upstream's files do you want?".
//
// Both the Source & sync link flow (`ProjectSettings/LinkSourceFlow`, AQU-1559)
// and Create New Project (`ProjectCreateDialog`) ask that question, and the
// issue's requirement is that they never drift apart: one list, one check-all
// control, one set of strings. So the markup and the `projectSettings.linkSource.*`
// keys live here and both callers render this.
//
// State stays with the caller. Each flow owns when the selection is seeded and
// cleared — the link flow on entering/leaving its confirm step, the create
// dialog on the upstream changing — and both of those resets have to reach the
// rest of their own form, so this component takes the set and reports presses
// rather than holding anything.
//
// AQU-1679: a row whose name matches exactly one file the project already has
// can also carry "replace the source in my existing file" — the link then
// follows INTO that file instead of adding a second copy. Only the link flow
// passes `replace`; a project being created has no files of its own to replace.

import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import { summarizeFileSelection } from "@/lib/sync/link-file-selection"
import type { LinkSourcePreviewFile } from "@/lib/sync/link-source-preview"
import type { ReplaceFileChoices, ReplaceMatchState } from "@/hooks/useReplaceFileChoices"

export type { ReplaceMatchState }

/** AQU-2549: the shared replace choice (useReplaceFileChoices). */
export type UpstreamFileReplaceChoice = ReplaceFileChoices

export interface UpstreamFileChoiceListProps {
  /** The upstream's files, in the upstream's own order. Empty renders nothing —
   *  an upstream with no files is a linkable situation with no list to show. */
  files: readonly LinkSourcePreviewFile[]
  /** The upstream file ids currently checked. */
  selectedFileIds: ReadonlySet<string>
  /** One row pressed. */
  onToggleFile: (fileId: string) => void
  /** The check-all control pressed: true = every file, false = none. */
  onToggleAll: (checked: boolean) => void
  /** AQU-1679: offer "replace the source in my existing file" on checked
   *  rows (AQU-2549: any row, when the project has files to choose from).
   *  Omitted = never offered. */
  replace?: UpstreamFileReplaceChoice
  disabled?: boolean
}

export function UpstreamFileChoiceList({
  files,
  selectedFileIds,
  onToggleFile,
  onToggleAll,
  replace,
  disabled,
}: UpstreamFileChoiceListProps) {
  const t = useT()
  const { selectedCount, allSelected } = useMemo(
    () => summarizeFileSelection(files, selectedFileIds),
    [files, selectedFileIds],
  )

  // AQU-2549: two rows pointed at the same file of the project's — only one
  // can follow into it.
  const takenIds = useMemo(
    () =>
      replace
        ? replace.takenTargets(files.filter((f) => selectedFileIds.has(f.id) && replace.replaceFileIds.has(f.id)).map((f) => f.id))
        : new Set<string>(),
    [replace, files, selectedFileIds],
  )

  if (files.length === 0) return null

  return (
    <div className="space-y-2" data-testid="upstream-file-choices">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={allSelected}
          // A partial pick is visually distinct from "all" — the control is one
          // press away from either, so it must not read as already-all.
          indeterminate={selectedCount > 0 && !allSelected}
          disabled={disabled}
          onCheckedChange={(checked) => onToggleAll(!!checked)}
        />
        {t("projectSettings.linkSource.selectAllFiles")}
      </label>
      {/* Rows are the upstream's own order, scrolled rather than paged — an
          upstream can hold 66 books or more, and someone unchecking three of
          them should not have to hunt pages. */}
      <ul className="max-h-56 space-y-1 overflow-y-auto rounded border px-3 py-2">
        {files.map((f) => (
          <li key={f.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selectedFileIds.has(f.id)}
                disabled={disabled}
                onCheckedChange={() => onToggleFile(f.id)}
              />
              <span className="truncate">{f.name}</span>
              {/* The row's own clash marker, so a warning that names the files
                  has rows to point at. Never set on a brand-new project, which
                  has no files of its own to collide with. */}
              {f.clashes && (
                <Badge variant="outline" className="shrink-0 text-amber-700 dark:text-amber-300">
                  {t("projectSettings.linkSource.fileClashBadge")}
                </Badge>
              )}
            </label>
            {/* AQU-1679: only on a row that is coming — an unchecked file
                replaces nothing. */}
            {replace && selectedFileIds.has(f.id) && replaceOfferedFor(f, replace) && (
              <ReplaceFileOption
                file={f}
                choices={replace}
                taken={takenIds.has(f.id)}
                disabled={disabled}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** AQU-2549: whether a row can offer the replace at all — it shares a name
 *  with one file here, or the project has files the lead can pick from. */
export function replaceOfferedFor(
  file: Pick<LinkSourcePreviewFile, "clashFileId">,
  choices: Pick<ReplaceFileChoices, "ownFiles">,
): boolean {
  return file.clashFileId !== undefined || choices.ownFiles.length > 0
}

/**
 * AQU-1679 / AQU-2549: "replace the source in my existing file", with the
 * project's file it follows into. The file starts as the one sharing the
 * row's name, if exactly one does, and the lead can pick any other of his
 * files; the comparison under it is for the file now picked. Shared by the
 * link flow and "Choose files" (ChooseLinkedFilesDialog).
 */
export function ReplaceFileOption({
  file,
  choices,
  taken,
  disabled,
}: {
  file: Pick<LinkSourcePreviewFile, "id" | "name" | "clashFileId">
  choices: ReplaceFileChoices
  /** Another row has picked the same file. */
  taken: boolean
  disabled?: boolean
}) {
  const t = useT()
  const on = choices.replaceFileIds.has(file.id)
  const target = choices.targetOf(file.id)
  const targetName =
    choices.ownFiles.find((f) => f.id === target)?.name ?? (target !== undefined && target === file.clashFileId ? file.name : undefined)
  return (
    <div className="mb-1 ml-6 space-y-1">
      <label className="flex items-start gap-2 text-xs">
        <Checkbox
          className="mt-0.5"
          checked={on}
          disabled={disabled}
          onCheckedChange={(checked) => choices.toggleReplace(file.id, !!checked)}
        />
        {targetName
          ? t("projectSettings.linkSource.replaceOption", { name: targetName })
          : t("projectSettings.linkSource.replaceOptionChoose")}
      </label>
      {on && choices.ownFiles.length > 0 && (
        <div className="ml-6">
          <Select
            items={choices.ownFiles.map((f) => ({ value: f.id, label: f.name }))}
            value={target ?? null}
            onValueChange={(value) => {
              if (typeof value === "string" && value) choices.chooseTarget(file.id, value)
            }}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="h-7 w-full max-w-xs text-xs"
              aria-label={t("projectSettings.linkSource.replaceTargetLabel", { name: file.name })}
            >
              <SelectValue placeholder={t("projectSettings.linkSource.replaceTargetPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {choices.ownFiles.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {on && target &&
        (taken ? (
          <p className="text-xs text-destructive" role="alert">
            {t("projectSettings.linkSource.replaceTargetTaken", { name: targetName ?? "" })}
          </p>
        ) : (
          <ReplaceMatchNote state={choices.matches.get(file.id)} />
        ))}
    </div>
  )
}

/** AQU-1679: what replacing this file's source will do, in the server's own
 *  numbers — or why it cannot be done. Shared with "Choose files"
 *  (ChooseLinkedFilesDialog), which offers the same option on an existing link. */
export function ReplaceMatchNote({ state }: { state: ReplaceMatchState | undefined }) {
  const t = useT()
  if (!state || state.status === "loading") {
    return (
      <p className="text-xs text-muted-foreground">
        {t("projectSettings.linkSource.replaceComparing")}
      </p>
    )
  }
  if (state.status === "failed") {
    return (
      <p className="text-xs text-destructive" role="alert">
        {t("projectSettings.linkSource.replaceCompareFailed")}
      </p>
    )
  }
  const { match } = state
  // AQU-2549: a staged import is a wait, not "only 0 of 0 lines match".
  if (match.importing) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {t("projectSettings.linkSource.replaceStillImporting")}
      </p>
    )
  }
  const lines = Math.max(match.upstreamLines, match.localLines)
  if (!match.canReplace) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {t("projectSettings.linkSource.replaceNoMatch", { same: match.same, count: lines })}
      </p>
    )
  }
  return (
    <ul className="text-xs text-muted-foreground">
      <li>{t("projectSettings.linkSource.replaceMatchSame", { same: match.same, count: lines })}</li>
      {match.changed > 0 && (
        <li>{t("projectSettings.linkSource.replaceMatchChanged", { count: match.changed })}</li>
      )}
      {match.added > 0 && (
        <li>{t("projectSettings.linkSource.replaceMatchAdded", { count: match.added })}</li>
      )}
      {match.kept > 0 && (
        <li>{t("projectSettings.linkSource.replaceMatchKept", { count: match.kept })}</li>
      )}
    </ul>
  )
}
