import { useState } from "react"
import { Button } from "@/components/ui/button"
import { importMacula, type MaculaProgress } from "@/lib/import"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import { RichMessage } from "@/lib/i18n/RichMessage"
import type { FileReference } from "@/lib/parsers/types"

interface MaculaPanelProps {
  projectId: string
  username: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (refs: FileReference[]) => void | Promise<void>
}

export function MaculaPanel({ projectId, username, getToken, onImported }: MaculaPanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<MaculaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)

  async function handleImport() {
    if (!file || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    try {
      const refs = await importMacula(file, { projectId, author: username, getToken }, setProgress)
      await onImported(refs)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        <RichMessage
          k="importExport.macula.description"
          values={{
            link: (
              <a
                href="https://github.com/Clear-Bible/macula-hebrew"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t("importExport.macula.linkText")}
              </a>
            ),
          }}
        />
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label />}>
          {file ? file.name : t("importExport.macula.chooseFile")}
          <input
            type="file"
            className="hidden"
            accept=".tsv,.txt,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        {file && !importing && (
          <p className="text-xs text-muted-foreground">{file.name} — {(file.size / 1024).toFixed(0)} KB</p>
        )}
      </div>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && t("importExport.macula.parsing")}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                {t("importExport.macula.uploadingCells", {
                  enqueued: formatNumber(progress.cellsEnqueued ?? 0, locale),
                  total: formatNumber(progress.cellsTotal, locale),
                })}
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
        </Button>
      </div>
    </div>
  )
}
