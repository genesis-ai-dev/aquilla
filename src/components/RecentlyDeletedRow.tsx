// FRO-272: one row of the "Recently deleted" dialog (ProjectWorkspace).
//
// AQU-2549: a copy that was joined into one of the project's own files cannot
// be restored — it would come back as a second file that no longer follows
// the source. The server refuses that restore; the row says why in place of
// the Restore button, naming the file it was joined into. Delete forever
// stays.

import { useT } from "@/lib/i18n/I18nProvider"
import type { FileSummary } from "@/lib/sync/cells-read-types"

export function RecentlyDeletedRow({
  file,
  onRestore,
  onPurge,
}: {
  file: Pick<FileSummary, "fileId" | "name" | "joinedInto">
  onRestore: () => void
  onPurge: () => void
}) {
  const t = useT()
  return (
    <div className="rounded px-1 py-1 text-sm hover:bg-accent">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-muted-foreground">{file.name}</span>
        {/* AQU-2260: labelled buttons say nothing on hover; what
            Delete forever does is the retention note below. */}
        {!file.joinedInto && (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-xs hover:bg-muted"
            onClick={onRestore}
          >
            {t("common.restore")}
          </button>
        )}
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-destructive hover:bg-destructive/10"
          onClick={onPurge}
        >
          {t("workspace.trash.deleteForever")}
        </button>
      </div>
      {file.joinedInto && (
        <p className="pt-0.5 text-xs leading-snug text-muted-foreground">
          {t("workspace.trash.joinedInto", { name: file.joinedInto.name })}
        </p>
      )}
    </div>
  )
}
